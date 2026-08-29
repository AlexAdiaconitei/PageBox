import { z } from 'zod';
import { formatBytes } from '$lib/format';
import { lazy } from './lazy';

// Re-exported because the config module is where callers already reach for the byte
// limits it prints; the implementation is shared with the panel (see $lib/format).
export { formatBytes };

/**
 * Single source of truth for runtime configuration.
 *
 * Parsed once, on first use (see getConfig). Anything invalid must stop the process — a
 * misconfigured host split silently removes the main security boundary of PageBox
 * (see docs/PLAN-static-hosting.md §D1), so it is not a warning.
 */

/**
 * Sizes are written the way people say them out loud: `1GB`, `1gb`, `500MB`, `1.5 GB`. A
 * plain number is still a number of bytes, so every configuration written before this
 * parses to exactly what it did.
 *
 * The units are binary — `1GB` is 1073741824, and `GB` and `GiB` mean the same thing. That
 * is the unfashionable reading, and it is the one that round-trips: `formatBytes` divides by
 * 1024 and prints `GB`, so a decimal `GB` here would mean the panel answers `931.3 GB` to
 * somebody who typed `1TB`, which reads as a bug in the arithmetic rather than a difference
 * of opinion about SI prefixes.
 *
 * Fractions are allowed and round to the nearest byte: `0.5GB` is a reasonable quota, and
 * nobody should have to multiply it out by hand.
 */
const SIZE_UNITS: Record<string, number> = {
	'': 1,
	b: 1,
	k: 1024,
	kb: 1024,
	kib: 1024,
	m: 1024 ** 2,
	mb: 1024 ** 2,
	mib: 1024 ** 2,
	g: 1024 ** 3,
	gb: 1024 ** 3,
	gib: 1024 ** 3,
	t: 1024 ** 4,
	tb: 1024 ** 4,
	tib: 1024 ** 4,
	p: 1024 ** 5,
	pb: 1024 ** 5,
	pib: 1024 ** 5
};

const SIZE_HINT =
	'must be a size like 500MB, 1.5GB or 1073741824 (plain numbers are bytes; ' +
	'KB/MB/GB/TB are 1024-based, and KiB/MiB/GiB mean the same)';

/**
 * `null` for anything that is not a size — including the near-misses that would otherwise
 * be read as something smaller than intended. `100 MB free` is not 100 MB, and quietly
 * taking the digits off the front of a typo is how a cap ends up an order of magnitude off.
 */
export function parseSize(raw: unknown): number | null {
	const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(String(raw ?? '').trim());
	if (!match) return null;
	const unit = SIZE_UNITS[match[2].toLowerCase()];
	if (unit === undefined) return null;
	const value = Number(match[1]) * unit;
	return Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * A size with a default. Written against `unknown` rather than `z.coerce.number()` because
 * the input is now a small language rather than a number, and the failure has to say so:
 * `MAX_UPLOAD_BYTES: must be a size like 500MB` is actionable, `expected number, received
 * string` is not.
 */
const bytes = (fallback: number) =>
	z
		.unknown()
		.optional()
		.transform((raw, ctx) => {
			if (raw === undefined || raw === '') return fallback;
			const parsed = parseSize(raw);
			if (parsed === null || parsed <= 0) {
				ctx.addIssue({ code: 'custom', message: SIZE_HINT });
				return z.NEVER;
			}
			return parsed;
		});

/** The same, for a setting whose absence is itself meaningful. */
const optionalBytes = () =>
	z
		.unknown()
		.optional()
		.transform((raw, ctx) => {
			if (raw === undefined || raw === '') return undefined;
			const parsed = parseSize(raw);
			if (parsed === null || parsed <= 0) {
				ctx.addIssue({ code: 'custom', message: SIZE_HINT });
				return z.NEVER;
			}
			return parsed;
		});

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
	//
	// Every *_BYTES setting takes a unit — `100MB`, `1.5GB` — or a plain number of bytes.
	MAX_UPLOAD_BYTES: bytes(100 * 1024 * 1024),
	MAX_UNCOMPRESSED_BYTES: bytes(500 * 1024 * 1024),
	MAX_FILES: z.coerce.number().int().positive().default(20_000),
	MAX_ZIP_RATIO: z.coerce.number().int().positive().default(100),

	// --- storage quotas -------------------------------------------------------
	//
	// PAGEBOX_STORAGE_BYTES is what this instance has to give away, and it is a
	// *declaration*: S3 exposes no capacity figure, so nothing can measure it for you —
	// MinIO and Garage only report disk size through their own non-S3 admin APIs. Set it
	// and the pool becomes real: allocated, free, and a superadmin whose own room shrinks
	// with every quota it hands out. Leave it unset and per-admin quotas still hold; there
	// is simply no pool arithmetic to do.
	//
	// Written with a unit — `PAGEBOX_STORAGE_BYTES=1GB`, `500GB`, `2TB` — or as a plain
	// number of bytes. It is the one figure an operator reads off a disk and types in, and
	// eleven digits is how a terabyte becomes a gigabyte.
	PAGEBOX_STORAGE_BYTES: optionalBytes(),
	// What a newly seated admin is offered on the form. Editable there; this is the
	// starting figure, not a cap.
	PAGEBOX_DEFAULT_QUOTA_BYTES: bytes(5 * 1024 * 1024 * 1024),

	// --- credential throttling ------------------------------------------------
	//
	// Counted per IP and per account, and only failures count. Raise the attempt count
	// for a team behind one NAT, where every colleague shares an address.
	LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
	LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),

	// Per deploy token, enforced by the api-key plugin on every verification. A CI job
	// uploads a handful of times an hour; this only stops a leaked token being useful.
	API_KEY_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
	API_KEY_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),

	// --- startup tasks -------------------------------------------------------
	PAGEBOX_MIGRATE_ON_START: z.stringbool().default(true),
	PAGEBOX_ENSURE_BUCKET_ON_START: z.stringbool().default(true)

	// Per-site subdomains (§12) are a v2 shape, and the two variables that used to sit here
	// for them were read by nothing. A configuration key that does not affect behaviour is
	// worse than an absent one: it reads as a switch. `site.hostname` stays, because
	// /whoami does report it.
});

export type Config = z.infer<typeof schema> & {
	/** Upload cap expressed for humans, for error messages. */
	maxUploadLabel: string;
};

/**
 * Values that mean "I have not set this yet", in every spelling the example files, the
 * README and the usual copy-paste have ever used. Matched loosely on purpose: a secret
 * that reads as an instruction is a secret nobody chose.
 */
const PLACEHOLDERS = [
	'change-me',
	'changeme',
	'change_me',
	'replace-me',
	'replaceme',
	'your-secret',
	'secret',
	'password',
	'pagebox',
	'admin',
	'xxx'
];

/**
 * True when this configuration describes an instance somebody else could reach.
 *
 * `NODE_ENV` alone is the wrong test: the Docker image sets it to production, and the
 * compose stack people run on their laptop uses that image. A `*.localhost` hostname
 * resolves to the loopback address and nowhere else, so an instance served under one is
 * not addressable no matter what mode it runs in.
 */
function isReachable(c: z.infer<typeof schema>): boolean {
	if (c.NODE_ENV !== 'production') return false;
	const local = (host: string) =>
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host.endsWith('.test');
	return !(local(c.PAGEBOX_ADMIN_HOST.split(':')[0]) && local(c.PAGEBOX_SITES_HOST.split(':')[0]));
}

export function isPlaceholder(value: string | undefined): boolean {
	if (!value) return false;
	const normalised = value.trim().toLowerCase();
	// A repeated single character ("xxxxxxxx", "aaaa…") is padding, not a password.
	if (/^(.)\1+$/.test(normalised)) return true;
	return PLACEHOLDERS.some((seed) => normalised === seed || normalised.startsWith(seed));
}

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
	// A default nobody could ever be given is a misconfiguration worth catching at boot
	// rather than at the first attempt to seat an admin.
	if (c.PAGEBOX_STORAGE_BYTES && c.PAGEBOX_DEFAULT_QUOTA_BYTES > c.PAGEBOX_STORAGE_BYTES) {
		errors.push(
			'PAGEBOX_DEFAULT_QUOTA_BYTES cannot exceed PAGEBOX_STORAGE_BYTES ' +
				`(${formatBytes(c.PAGEBOX_DEFAULT_QUOTA_BYTES)} of ${formatBytes(c.PAGEBOX_STORAGE_BYTES)})`
		);
	}
	// Deliberately *not* an error: the pool holding less than what has already been handed
	// out is a data condition, and a data condition must not stop a container booting. The
	// panel says over-allocated and refuses further allocation until it is resolved.
	if (Boolean(c.BOOTSTRAP_ADMIN_EMAIL) !== Boolean(c.BOOTSTRAP_ADMIN_PASSWORD)) {
		errors.push('BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together');
	}
	// The credentials from `.env.example` open the whole instance, and they are the ones
	// people actually ship — that is what an example file is for. They are a convenience on
	// a machine nobody else can reach and a published credential anywhere else, so the
	// process refuses to carry them once it is addressable under a real hostname. Never
	// echoed back: an error message is a log line, and a log line is not a place for a
	// secret, placeholder or not.
	if (isReachable(c)) {
		if (isPlaceholder(c.BOOTSTRAP_ADMIN_PASSWORD)) {
			errors.push(
				'BOOTSTRAP_ADMIN_PASSWORD is one of the example values — it is the first ' +
					'superadmin credential of this instance, so set a real one'
			);
		}
		if (isPlaceholder(c.AUTH_SECRET)) {
			errors.push(
				'AUTH_SECRET is one of the example values — generate one with ' +
					'`openssl rand -base64 48`. Every session cookie is signed with it.'
			);
		}
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

export const config: Config = lazy(getConfig);

/** Which of the two hostnames a request arrived on, or null for anything else. */
export type HostKind = 'admin' | 'sites';

export function hostKind(host: string): HostKind | null {
	const h = host.toLowerCase().split(':')[0];
	if (h === config.PAGEBOX_ADMIN_HOST.split(':')[0]) return 'admin';
	if (h === config.PAGEBOX_SITES_HOST.split(':')[0]) return 'sites';
	return null;
}

/**
 * Absolute URL of a site, built from config — never from request headers.
 *
 * `port` is the one thing worth taking from the current request: both hosts are served by
 * the same process, so a link printed without it is dead on a dev server or any deployment
 * that does not sit on 80/443. It is a port number, not a hostname: it cannot redirect a
 * link somewhere else.
 */
export function siteUrl(basePath: string, port?: string | null): string {
	return `${config.PAGEBOX_PUBLIC_SCHEME}://${config.PAGEBOX_SITES_HOST}${suffix(port)}${basePath}`;
}

export function adminUrl(path = '/', port?: string | null): string {
	return `${config.PAGEBOX_PUBLIC_SCHEME}://${config.PAGEBOX_ADMIN_HOST}${suffix(port)}${path}`;
}

function suffix(port?: string | null): string {
	if (!port || config.PAGEBOX_SITES_HOST.includes(':')) return '';
	return port === '80' || port === '443' ? '' : `:${port}`;
}

export function basePathFor(slug: string): string {
	return `${config.PAGEBOX_SITES_PREFIX}/${slug}/`;
}
