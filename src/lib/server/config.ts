import { domainToASCII } from 'node:url';
import { z } from 'zod';
import { formatBytes, parseSize, SIZE_HINT } from '$lib/format';
import { lazy } from './lazy';

// Re-exported because the config module is where callers already reach for the byte
// limits it prints and the size syntax it accepts; both live in $lib/format, because the
// panel enters sizes too and one syntax deserves exactly one parser.
export { formatBytes, parseSize };

/**
 * Single source of truth for runtime configuration.
 *
 * Parsed once, on first use (see getConfig). Anything invalid must stop the process — a
 * misconfigured host split silently removes the main security boundary of PageBox
 * (see docs/PLAN-static-hosting.md §D1), so it is not a warning.
 */

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
	.refine((v) => {
		const [host, port, extra] = v.split(':');
		return (
			!extra &&
			host.length <= 253 &&
			host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
			(port === undefined || (/^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535))
		);
	}, 'must be a DNS hostname with an optional valid port');

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
	BOOTSTRAP_ADMIN_PASSWORD: z.string().min(10).max(200).optional(),

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
	MAX_UPLOAD_TEMP_BYTES: bytes(400 * 1024 * 1024),
	MAX_CONCURRENT_UPLOADS: z.coerce.number().int().min(1).max(32).default(4),
	UPLOAD_BODY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(60),
	UPLOAD_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
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
	// Counted per IP and endpoint, including successful requests. Raise the attempt count
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
	const adminHost = c.PAGEBOX_ADMIN_HOST.split(':')[0];
	const sitesHost = c.PAGEBOX_SITES_HOST.split(':')[0];
	if (adminHost === sitesHost) {
		errors.push(
			'PAGEBOX_ADMIN_HOST and PAGEBOX_SITES_HOST must be different hostnames ' +
				`(both are "${c.PAGEBOX_ADMIN_HOST}")`
		);
	}
	if (adminHost.endsWith('.' + sitesHost))
		errors.push('PAGEBOX_ADMIN_HOST must be outside the reader subdomain namespace');
	try {
		const database = new URL(c.DATABASE_URL);
		if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error();
		if (
			c.NODE_ENV === 'production' &&
			(!database.password || isPlaceholder(decodeURIComponent(database.password)))
		)
			errors.push('DATABASE_URL requires a chosen database password in production');
	} catch {
		errors.push('DATABASE_URL must be a valid PostgreSQL URL');
	}
	if (!['http:', 'https:'].includes(new URL(c.S3_ENDPOINT).protocol))
		errors.push('S3_ENDPOINT must use HTTP or HTTPS');
	// Grant caching is per-process. With more than one process, a revoked grant would
	// stay live in the other replicas until its TTL expires.
	if (c.PAGEBOX_REPLICAS > 1 && !c.REDIS_URL) {
		errors.push('PAGEBOX_REPLICAS > 1 requires REDIS_URL (shared metadata cache)');
	}
	if (c.MAX_UPLOAD_BYTES > c.MAX_UNCOMPRESSED_BYTES) {
		errors.push('MAX_UPLOAD_BYTES cannot exceed MAX_UNCOMPRESSED_BYTES');
	}
	if (c.MAX_UPLOAD_TEMP_BYTES < c.MAX_UPLOAD_BYTES)
		errors.push('MAX_UPLOAD_TEMP_BYTES must fit at least one MAX_UPLOAD_BYTES archive');
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
	if (c.NODE_ENV === 'production') {
		if (
			isPlaceholder(c.S3_SECRET_KEY) ||
			['pagebox', 'minioadmin'].includes(c.S3_ACCESS_KEY.toLowerCase())
		)
			errors.push('S3 credentials must be chosen values, not infrastructure examples');
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

const hostOnly = (host: string) => host.toLowerCase().split(':')[0];

export function hostKind(host: string): HostKind | null {
	const h = hostOnly(host);
	if (h === hostOnly(config.PAGEBOX_ADMIN_HOST)) return 'admin';
	if (h === hostOnly(config.PAGEBOX_SITES_HOST)) return 'sites';
	return null;
}

/**
 * Validates a custom domain an owner types for a site, and returns it in the one spelling
 * the resolver compares against: lowercase ASCII, no trailing dot. A port is kept because
 * local stacks run on one; a public domain never carries one.
 *
 * Returns an error message instead of throwing: this is form input, not configuration.
 */
export function normaliseSiteDomain(input: string): { hostname: string } | { error: string } {
	const raw = input
		.trim()
		.toLowerCase()
		.replace(/\.(?=:|$)/, '');
	if (!raw) return { error: 'Type a domain' };
	if (/[/?#@\s\\]/.test(raw) || raw.includes('://'))
		return { error: 'Type only the domain, like docs.example.com — no scheme or path' };
	const [name, port, extra] = raw.split(':');
	if (extra !== undefined || (port !== undefined && !/^[1-9][0-9]{0,4}$/.test(port)))
		return { error: 'That is not a valid domain' };
	const ascii = domainToASCII(name);
	if (
		!ascii ||
		ascii.length > 253 ||
		!ascii.includes('.') ||
		/^[0-9.]+$/.test(ascii) ||
		!ascii.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	)
		return { error: 'That is not a valid domain' };
	const admin = hostOnly(config.PAGEBOX_ADMIN_HOST);
	// The panel and the reader login hold PageBox's own cookies; uploaded content never
	// shares, or sits under, the panel's origin.
	if (
		ascii === admin ||
		ascii.endsWith('.' + admin) ||
		ascii === hostOnly(config.PAGEBOX_SITES_HOST)
	)
		return { error: 'That domain belongs to PageBox itself' };
	return { hostname: port ? `${ascii}:${port}` : ascii };
}

/**
 * Absolute URL of a site, built from config and the stored row — never from request
 * headers. A site with a custom domain is served from that domain's root; any other site
 * lives under the shared sites host.
 */
export function siteUrl(site: { hostname: string | null; basePath: string }): string {
	const host = site.hostname ?? config.PAGEBOX_SITES_HOST;
	return `${config.PAGEBOX_PUBLIC_SCHEME}://${host}${site.basePath}`;
}

export function readerUrl(path: string): string {
	return `${config.PAGEBOX_PUBLIC_SCHEME}://${config.PAGEBOX_SITES_HOST}${path}`;
}

export function adminUrl(path = '/', _port?: string | null): string {
	return `${config.PAGEBOX_PUBLIC_SCHEME}://${config.PAGEBOX_ADMIN_HOST}${path}`;
}

export function basePathFor(slug: string): string {
	return `${config.PAGEBOX_SITES_PREFIX}/${slug}/`;
}
