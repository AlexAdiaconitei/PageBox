/**
 * Shared harness for the integration suites.
 *
 * The three suites written before this one each grew their own copy of a cookie jar, a
 * request helper and a sign-in — which was fine while there were three, and stopped being
 * fine when the features that needed covering (disabling, retention, roles, quotas) each
 * wanted a *second* account and a build to deploy. Everything here is what those copies
 * agreed on; nothing new is invented.
 */
import { zipSync } from 'fflate';
import postgres from 'postgres';
import { afterAll } from 'vitest';

export const base = process.env.PAGEBOX_E2E_BASE;
export const email = process.env.PAGEBOX_E2E_EMAIL;
export const password = process.env.PAGEBOX_E2E_PASSWORD;
export const adminHost = process.env.PAGEBOX_E2E_ADMIN_HOST ?? 'pagebox.localhost';
export const sitesHost = process.env.PAGEBOX_E2E_SITES_HOST ?? 'pages.localhost';
export const hostHeader = process.env.PAGEBOX_E2E_HOST_HEADER ?? 'x-forwarded-host';

/** Set when the suite has an account to work with; otherwise these tests skip. */
export const configured = Boolean(base && email && password);

let fixtureSql: ReturnType<typeof postgres> | undefined;
afterAll(async () => {
	await fixtureSql?.end();
});

/** The custom domain a site is served from, or null when it lives under `/s/<slug>/`. */
export async function siteHost(slug: string): Promise<string | null> {
	if (process.env.PAGEBOX_DB_TESTS !== '1')
		throw new Error('Per-site tests require PAGEBOX_DB_TESTS=1 and a disposable database');
	fixtureSql ??= postgres(process.env.DATABASE_URL_HOST ?? process.env.DATABASE_URL!, { max: 2 });
	const [row] = await fixtureSql`select hostname from site where slug = ${slug}`;
	return row?.hostname ?? null;
}

/** Gives a site its own origin through the panel, the way an admin does. */
export async function giveDomain(jar: Jar, slug: string): Promise<string> {
	const port = sitesHost.includes(':') ? ':' + sitesHost.split(':').at(-1) : '';
	const hostname = `${slug}.domains.localhost${port}`;
	const response = await post(`/sites/${slug}?/domain`, jar, { hostname });
	const result = await actionResult(response);
	if (result.type !== 'success') throw new Error(`could not give ${slug} a domain: ${result.type}`);
	return hostname;
}

/**
 * Requests `/s/<slug>/<path>` the way a reader reaches it: on the shared sites host, or —
 * for a site with its own domain — at `<domain>/<path>` after the central reader flow.
 */
export async function siteRequest(path: string, options: Parameters<typeof request>[1] = {}) {
	const match = /^\/s\/([^/?]+)\/?/.exec(path);
	if (!match) return request(path, options);
	const slug = match[1];
	const host = await siteHost(slug);
	if (!host) return request(path, { ...options, host: sitesHost });
	const local = '/' + path.slice(match[0].length);
	const child: Jar = new Map();
	if (options?.jar && [...options.jar.keys()].some((name) => name.includes('pb_view'))) {
		const issued = await request(
			'/access?site=' + encodeURIComponent(slug) + '&next=' + encodeURIComponent(local),
			{ host: sitesHost, jar: options.jar }
		);
		if (issued.status === 404) return issued;
		const location = issued.headers.get('location');
		if (location?.includes('/__pb/accept?')) {
			const url = new URL(location);
			const accepted = await request(url.pathname + url.search, { host: url.host });
			if (accepted.status !== 302) return accepted;
			store(child, accepted);
		}
	}
	return request(local, { ...options, host, jar: child });
}

/**
 * A fresh address per run. better-auth's rate limiter counts every request to
 * /sign-in/email, not just the failed ones, so a fixed address makes repeated runs throttle
 * themselves — which looks exactly like a broken login.
 */
export const callerIp = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

/** Distinguishes one run's fixtures from the last one's, since nothing resets the database. */
export const tag = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

export type Jar = Map<string, string>;

export function store(jar: Jar, res: Response) {
	for (const raw of res.headers.getSetCookie()) {
		const [pair] = raw.split(';');
		const index = pair.indexOf('=');
		jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
	}
}

export const cookieHeader = (jar: Jar) =>
	[...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

export function request(
	path: string,
	{
		jar,
		host = adminHost,
		method = 'GET',
		form,
		origin,
		headers: extra
	}: {
		jar?: Jar;
		host?: string;
		method?: string;
		form?: Record<string, string>;
		origin?: string | null;
		headers?: Record<string, string>;
	} = {}
) {
	const headers: Record<string, string> = {
		[hostHeader]: host,
		'x-forwarded-proto': 'http',
		'x-forwarded-for': callerIp,
		...extra
	};
	if (jar && jar.size) headers.cookie = cookieHeader(jar);
	if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
	if (origin !== null) headers.origin = origin ?? `http://${host}`;

	return fetch(`${base}${path}`, {
		method,
		headers,
		redirect: 'manual',
		body: form ? new URLSearchParams(form).toString() : undefined
	});
}

/** Posts a form action and keeps whatever cookies came back. */
export async function post(path: string, jar: Jar, form: Record<string, string>, host = adminHost) {
	const res = await request(path, { jar, host, method: 'POST', form });
	store(jar, res);
	return res;
}

export async function signIn(
	as: { email: string; password: string } = { email: email!, password: password! },
	host = adminHost
): Promise<Jar> {
	const jar: Jar = new Map();
	store(jar, await request('/login', { jar, host, method: 'POST', form: as }));
	return jar;
}

/**
 * A form action answers a non-HTML client with HTTP 200 and puts the real outcome in the
 * body, so asserting on `res.status` alone always passes and never means anything.
 */
export async function actionResult(
	res: Response
): Promise<{ type: string; status: number; raw: string }> {
	const raw = await res.text();
	try {
		const body = JSON.parse(raw) as { type?: string; status?: number };
		return { type: body.type ?? 'unknown', status: body.status ?? res.status, raw };
	} catch {
		return { type: 'unknown', status: res.status, raw };
	}
}

/** A zip of exactly these files, stored rather than deflated (as the panel builds them). */
export function buildZip(files: Record<string, string>): Uint8Array {
	const encoder = new TextEncoder();
	const payload: Record<string, Uint8Array> = {};
	for (const [path, body] of Object.entries(files)) payload[path] = encoder.encode(body);
	return zipSync(payload, { level: 0 });
}

/** A build of roughly `mb` megabytes, for the tests that need a size rather than content. */
export function buildOfSize(mb: number, marker = 'sized'): Uint8Array {
	const chunk = 'x'.repeat(64 * 1024);
	const files: Record<string, string> = { 'index.html': `<h1>${marker}</h1>` };
	for (let i = 0; i < mb * 16; i++) files[`bulk/${i}.txt`] = chunk;
	return buildZip(files);
}

/** Whatever the deploy endpoint answered. Loose on purpose: the tests assert the fields. */
export type UploadBody = Record<string, any>;

export async function upload(
	slug: string,
	zip: Uint8Array,
	{ jar, token, query = '' }: { jar?: Jar; token?: string; query?: string }
): Promise<{ status: number; body: UploadBody; transport?: string }> {
	const headers: Record<string, string> = {
		[hostHeader]: adminHost,
		'x-forwarded-for': callerIp,
		'content-type': 'application/zip'
	};
	if (jar) {
		headers.cookie = cookieHeader(jar);
		headers.origin = `http://${adminHost}`;
	}
	if (token) headers.authorization = `Bearer ${token}`;

	try {
		const res = await fetch(`${base}/api/v1/sites/${slug}/deployments${query}`, {
			method: 'POST',
			headers,
			body: zip as unknown as BodyInit
		});
		return { status: res.status, body: (await res.json().catch(() => ({}))) as UploadBody };
	} catch (err) {
		// A server that answers before reading the body closes the socket under us, and
		// undici reports that as a transport failure rather than the response it already
		// sent. Surfaced as status 0 so a test can say what it saw.
		return { status: 0, body: {}, transport: String(err) };
	}
}

/** Reads the `userId` a row's forms carry, which is how the panel exposes account ids. */
export function userIdFor(html: string, forEmail: string): string {
	const row = html.split('<tr').find((chunk) => chunk.includes(forEmail));
	return /name="userId" value="([^"]+)"/.exec(row ?? '')?.[1] ?? '';
}
