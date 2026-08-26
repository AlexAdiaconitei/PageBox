import { describe, expect, it } from 'vitest';

/**
 * End-to-end checks of the serving rules against a running stack.
 *
 *   docker compose up -d
 *   node scripts/seed-demo.mjs
 *   PAGEBOX_E2E_BASE=http://127.0.0.1:3000 pnpm test
 *
 * Skipped when PAGEBOX_E2E_BASE is unset, so `pnpm test` stays offline by default.
 */

const base = process.env.PAGEBOX_E2E_BASE;
const sitesHost = process.env.PAGEBOX_E2E_SITES_HOST ?? 'pages.localhost';
const adminHost = process.env.PAGEBOX_E2E_ADMIN_HOST ?? 'pagebox.localhost';
const slug = process.env.PAGEBOX_E2E_SLUG ?? 'demo';

const run = base ? describe : describe.skip;

/**
 * `fetch` refuses to set `host`, so the target hostname travels in `x-forwarded-host` —
 * the header the container entrypoint configures adapter-node to read, which is also how
 * Traefik addresses the app in production.
 */
const hostHeader = process.env.PAGEBOX_E2E_HOST_HEADER ?? 'x-forwarded-host';

const get = (path: string, init: RequestInit = {}, host = sitesHost) =>
	fetch(`${base}${path}`, {
		...init,
		redirect: 'manual',
		headers: { [hostHeader]: host, ...(init.headers ?? {}) }
	});

run('serving a deployment', () => {
	it('serves the site root', async () => {
		const res = await get(`/s/${slug}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(await res.text()).toContain('demo root');
	});

	// Without this every relative URL in the HTML would resolve one level too high.
	it('redirects a missing trailing slash', async () => {
		const res = await get(`/s/${slug}`);
		expect(res.status).toBe(301);
		expect(res.headers.get('location')).toBe(`/s/${slug}/`);
	});

	it('resolves extensionless paths through .html and /index.html', async () => {
		expect(await (await get(`/s/${slug}/about`)).text()).toContain('resolved via .html');
		expect(await (await get(`/s/${slug}/guide`)).text()).toContain('resolved via index');
		expect((await get(`/s/${slug}/guide/`)).status).toBe(200);
	});

	it('answers unknown paths with the site 404 page, at status 404', async () => {
		const res = await get(`/s/${slug}/nope`);
		expect(res.status).toBe(404);
		expect(await res.text()).toContain('custom 404');
	});

	it('never serves dotfiles, however they are requested', async () => {
		expect((await get(`/s/${slug}/.env`)).status).toBe(404);
		expect((await get(`/s/${slug}/__pb/anything`)).status).toBe(404);
	});

	it('types responses from its own table', async () => {
		expect((await get(`/s/${slug}/style.css`)).headers.get('content-type')).toBe(
			'text/css; charset=utf-8'
		);
		expect((await get(`/s/${slug}/assets/logo.png`)).headers.get('content-type')).toBe('image/png');
		expect((await get(`/s/${slug}/`)).headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('caches hashed assets forever and revalidates everything else', async () => {
		expect((await get(`/s/${slug}/assets/app-4f3a91b2.js`)).headers.get('cache-control')).toBe(
			'public, max-age=31536000, immutable'
		);
		expect((await get(`/s/${slug}/`)).headers.get('cache-control')).toBe('public, no-cache');
	});

	it('answers a matching If-None-Match with 304', async () => {
		const first = await get(`/s/${slug}/`);
		const etag = first.headers.get('etag')!;
		expect(etag).toBeTruthy();
		const second = await get(`/s/${slug}/`, { headers: { 'if-none-match': etag } });
		expect(second.status).toBe(304);
	});

	it('serves byte ranges', async () => {
		const res = await get(`/s/${slug}/style.css`, { headers: { range: 'bytes=0-14' } });
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toMatch(/^bytes 0-14\/\d+$/);
		expect((await res.text()).length).toBe(15);
	});

	it('serves precompressed siblings when accepted, but never with a range', async () => {
		const br = await get(`/s/${slug}/style.css`, { headers: { 'accept-encoding': 'br' } });
		expect(br.headers.get('content-encoding')).toBe('br');
		expect(br.headers.get('vary')).toContain('Accept-Encoding');

		const ranged = await get(`/s/${slug}/style.css`, {
			headers: { 'accept-encoding': 'br', range: 'bytes=0-9' }
		});
		expect(ranged.status).toBe(206);
		expect(ranged.headers.get('content-encoding')).toBeNull();
	});

	it('supports HEAD and rejects other methods', async () => {
		const head = await get(`/s/${slug}/style.css`, { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(head.headers.get('content-length')).toBeTruthy();
		expect((await get(`/s/${slug}/`, { method: 'POST' })).status).toBe(405);
	});

	// Who may read a private site is covered in private-sites.test.ts; here the point is
	// that an anonymous request never gets bytes and never gets a cacheable response.
	it('gives an anonymous caller nothing on a private site, assets included', async () => {
		for (const path of ['/', '/style.css', '/assets/app-4f3a91b2.js']) {
			const res = await get(`/s/${slug}-private${path}`);
			expect([401, 302, 404], path).toContain(res.status);
			expect(res.headers.get('content-type') ?? '', path).not.toContain('text/css');
			expect(res.headers.get('cache-control'), path).toBe('private, no-store');
			expect(res.headers.get('cdn-cache-control'), path).toBe('no-store');
		}
	});

	/**
	 * The wiring, not the wording: the unit tests pin what the page contains, this pins
	 * that the host dispatch and the site server actually reach it, over a real socket,
	 * with a browser's headers.
	 */
	it('answers a navigation with a page rather than a line of text', async () => {
		const res = await get(`/s/${slug}-does-not-exist/`, {
			headers: { 'sec-fetch-dest': 'document', accept: 'text/html' }
		});
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
		const body = await res.text();
		expect(body).toContain('<!doctype html>');
		// Self-contained: an error page that pulls a stylesheet from the site host is one
		// more request to an origin that may have nothing to answer it with.
		expect(body).not.toContain('<link');
		// The path is never echoed back — this origin is shared by every deployment on it.
		expect(body).not.toContain('does-not-exist');
	});

	// A sub-resource must not be handed a document: the browser rejects it on nosniff and
	// the real cause never surfaces.
	it('answers a sub-resource in plain text, at the same status', async () => {
		const res = await get(`/s/${slug}-does-not-exist/app.js`, {
			headers: { 'sec-fetch-dest': 'script' }
		});
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
	});

	it('does not serve sites from the admin host', async () => {
		expect((await get(`/s/${slug}/`, {}, adminHost)).status).toBe(404);
		expect((await get('/', {}, 'unknown.example.com')).status).toBe(404);
	});
});
