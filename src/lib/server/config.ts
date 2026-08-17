import { z } from 'zod';
import { lazy } from './lazy';

/**
 * Single source of truth for runtime configuration.
 *
 * Parsed once, on first use (see getConfig). Anything invalid must stop the process — a
 * misconfigured host split silently removes the main security boundary of PageBox
 * (see PLAN-static-hosting.md §D1), so it is not a warning.
 */

const bytes = (fallback: number) =>
	z.coerce.number().int().positive().default(fallback).describe('size in bytes');

const hostname = z
	.string()
	.min(1)
	.transform((v) => v.trim().toLowerCase())
	.refine((v) => !v.includes('/'), 'must be a bare hostname, without scheme or path');

const schema = z.object({
	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

	// --- hosts ---------------------------------------------------------------
	PAGEBOX_ADMIN_HOST: hostname,
	PAGEBOX_SITES_HOST: hostname,
	PAGEBOX_SITES_PREFIX: z
		.string()
		.default('/s')
		.transform((v) => '/' + v.replace(/^\/+|\/+$/g, ''))
		.refine((v) => /^\/[a-z0-9][a-z0-9-]*$/.test(v), 'must look like /s'),
	PAGEBOX_PUBLIC_SCHEME: z.enum(['http', 'https']).default('https'),
	PAGEBOX_REPLICAS: z.coerce.number().int().positive().default(1),

	// --- infra ---------------------------------------------------------------
	DATABASE_URL: z.string().min(1),
	DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
	REDIS_URL: z.string().optional(),

	S3_ENDPOINT: z.string().url(),
	S3_REGION: z.string().default('us-east-1'),
	S3_ACCESS_KEY: z.string().min(1),
	S3_SECRET_KEY: z.string().min(1),
	S3_BUCKET: z.string().min(1).default('pagebox'),
	S3_FORCE_PATH_STYLE: z.stringbool().default(true),

	// --- auth ----------------------------------------------------------------
	AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
	BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
	BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),

	// --- limits --------------------------------------------------------------
	//
	// MAX_UPLOAD_BYTES defaults to 100 MB because Cloudflare's proxy rejects larger
	// request bodies on non-Enterprise plans, and that is the deployment this was
	// designed for. It is a *default*, not a law: a deployment without Cloudflare in
	// front (plain Traefik, LAN, Tailscale…) can raise it freely. Whatever value is
	// set here also becomes adapter-node's BODY_SIZE_LIMIT, so the two can never drift.
	MAX_UPLOAD_BYTES: bytes(100 * 1024 * 1024),
	MAX_UNCOMPRESSED_BYTES: bytes(500 * 1024 * 1024),
	MAX_FILES: z.coerce.number().int().positive().default(20_000),
	MAX_ZIP_RATIO: z.coerce.number().int().positive().default(100),

	// --- startup tasks -------------------------------------------------------
	PAGEBOX_MIGRATE_ON_START: z.stringbool().default(true),
	PAGEBOX_ENSURE_BUCKET_ON_START: z.stringbool().default(true),

	// --- v2 (§12), no effect in v1 -------------------------------------------
	PAGEBOX_BASE_DOMAIN: z.string().optional(),
	PAGEBOX_SUBDOMAIN_MODE: z.stringbool().default(false)
});

export type Config = z.infer<typeof schema> & {
	/** Upload cap expressed for humans, for error messages. */
	maxUploadLabel: string;
};

function fail(lines: string[]): never {
	console.error('\n[pagebox] refusing to start — invalid configuration:\n');
	for (const line of lines) console.error('  • ' + line);
	console.error('');
	process.exit(1);
}

/**
 * Pure parse + cross-field validation. Returns errors instead of exiting so it can be
 * unit-tested; `getConfig()` is the one that turns errors into a dead process.
 */
export function parseConfig(env: Record<string, string | undefined>): {
	config?: Config;
	errors: string[];
} {
	const parsed = schema.safeParse(env);
	if (!parsed.success) {
		return {
			errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
		};
	}
	const c = parsed.data;
	const errors: string[] = [];

	// The host split is the boundary that stops hosted static content from calling the
	// admin API with the admin cookie attached. Same host = no boundary at all.
	if (c.PAGEBOX_ADMIN_HOST === c.PAGEBOX_SITES_HOST) {
		errors.push(
			'PAGEBOX_ADMIN_HOST and PAGEBOX_SITES_HOST must be different hostnames ' +
				`(both are "${c.PAGEBOX_ADMIN_HOST}")`
		);
	}
	// Grant caching is per-process. With more than one process, a revoked grant would
	// stay live in the other replicas until its TTL expires.
	if (c.PAGEBOX_REPLICAS > 1 && !c.REDIS_URL) {
		errors.push('PAGEBOX_REPLICAS > 1 requires REDIS_URL (shared grant cache)');
	}
	if (c.MAX_UPLOAD_BYTES > c.MAX_UNCOMPRESSED_BYTES) {
		errors.push('MAX_UPLOAD_BYTES cannot exceed MAX_UNCOMPRESSED_BYTES');
	}
	if (Boolean(c.BOOTSTRAP_ADMIN_EMAIL) !== Boolean(c.BOOTSTRAP_ADMIN_PASSWORD)) {
		errors.push('BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together');
	}
	if (errors.length) return { errors };

	return { config: { ...c, maxUploadLabel: formatBytes(c.MAX_UPLOAD_BYTES) }, errors: [] };
}

let loaded: Config | undefined;

/**
 * Parsed on first use, not at import: `vite build` imports every server module, and a
 * build machine has no PageBox environment. At runtime the first request — and the
 * startup tasks that run before it — hit this immediately, so a bad configuration still
 * kills the process at boot rather than later.
 */
export function getConfig(): Config {
	if (!loaded) {
		const { config, errors } = parseConfig(process.env);
		if (!config) fail(errors);
		loaded = config;
	}
	return loaded;
}

export function formatBytes(n: number): string {
	const units = ['B', 'KB', 'MB', 'GB'];
	let v = n;
	let u = 0;
	while (v >= 1024 && u < units.length - 1) {
		v /= 1024;
		u++;
	}
	return `${Math.round(v * 10) / 10} ${units[u]}`;
}

export const config: Config = lazy(getConfig);

/** Which of the two hostnames a request arrived on, or null for anything else. */
export type HostKind = 'admin' | 'sites';

export function hostKind(host: string): HostKind | null {
	const h = host.toLowerCase().split(':')[0];
	if (h === config.PAGEBOX_ADMIN_HOST.split(':')[0]) return 'admin';
	if (h === config.PAGEBOX_SITES_HOST.split(':')[0]) return 'sites';
	return null;
}

/** Absolute URL of a site, built from config — never from request headers. */
export function siteUrl(basePath: string): string {
	return `${config.PAGEBOX_PUBLIC_SCHEME}://${config.PAGEBOX_SITES_HOST}${basePath}`;
}

export function adminUrl(path = '/'): string {
	return `${config.PAGEBOX_PUBLIC_SCHEME}://${config.PAGEBOX_ADMIN_HOST}${path}`;
}

export function basePathFor(slug: string): string {
	return `${config.PAGEBOX_SITES_PREFIX}/${slug}/`;
}
