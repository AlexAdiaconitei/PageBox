import { beforeAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';

/**
 * The drag & drop path: the same deployment endpoint, reached with a panel session
 * instead of a deploy token.
 *
 *   docker compose up -d && node scripts/seed-demo.mjs
 *   PAGEBOX_E2E_BASE=http://127.0.0.1:3000 \
 *   PAGEBOX_E2E_EMAIL=admin@example.com PAGEBOX_E2E_PASSWORD=... pnpm test
 */

const base = process.env.PAGEBOX_E2E_BASE;
const email = process.env.PAGEBOX_E2E_EMAIL;
const password = process.env.PAGEBOX_E2E_PASSWORD;
const adminHost = process.env.PAGEBOX_E2E_ADMIN_HOST ?? 'pagebox.localhost';
const sitesHost = process.env.PAGEBOX_E2E_SITES_HOST ?? 'pages.localhost';
const hostHeader = process.env.PAGEBOX_E2E_HOST_HEADER ?? 'x-forwarded-host';
// Its own site: the deploy-API suite runs in parallel and also replaces what is live.
const slug = `${process.env.PAGEBOX_E2E_SLUG ?? 'demo'}-panel`;

/**
 * A fresh address per run. better-auth's rate limiter counts every request to
 * /sign-in/email, not just the failed ones, so a fixed address makes repeated runs throttle
 * themselves — which looks exactly like a broken login.
 */
const callerIp = `198.51.103.${Math.floor(Math.random() * 250) + 1}`;

const run = base && email && password ? describe : describe.skip;

const cookies = new Map<string, string>();
const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');

function proxyHeaders(host = adminHost): Record<string, string> {
	return {
		[hostHeader]: host,
		'x-forwarded-proto': 'http',
		'x-forwarded-for': callerIp
	};
}

const archive = (files: Record<string, string>) =>
	zipSync(
		Object.fromEntries(Object.entries(files).map(([path, body]) => [path, strToU8(body)])),
		// Store mode, exactly like the browser: the ratio stays 1:1 and never looks like a bomb.
		{ level: 0 }
	);

function upload(
	body: Uint8Array,
	{ query = '', withOrigin = true, withCookies = true } = {}
): Promise<Response> {
	return fetch(`${base}/api/v1/sites/${slug}/deployments${query}`, {
		method: 'POST',
		redirect: 'manual',
		headers: {
			...proxyHeaders(),
			'content-type': 'application/zip',
			...(withOrigin ? { origin: `http://${adminHost}` } : {}),
			...(withCookies ? { cookie: cookieHeader() } : {})
		},
		body: body as unknown as BodyInit
	});
}

run('panel uploads', () => {
	beforeAll(async () => {
		const res = await fetch(`${base}/login`, {
			method: 'POST',
			redirect: 'manual',
			headers: {
				...proxyHeaders(),
				origin: `http://${adminHost}`,
				'content-type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({ email: email!, password: password! }).toString()
		});
		for (const raw of res.headers.getSetCookie()) {
			const [pair] = raw.split(';');
			const index = pair.indexOf('=');
			cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
		}
		expect([...cookies.keys()].some((name) => name.startsWith('pb_admin'))).toBe(true);
	});

	it('deploys a build sent with the panel session', async () => {
		const marker = `dropped-${Date.now()}`;
		const res = await upload(
			archive({ 'index.html': `<!doctype html><h1>${marker}</h1>`, 'style.css': 'body{}' })
		);
		expect(res.status).toBe(201);

		const body = await res.json();
		expect(body.fileCount).toBe(2);

		const page = await fetch(`${base}/s/${slug}/`, { headers: proxyHeaders(sitesHost) });
		expect(await page.text()).toContain(marker);
	});

	it('records the upload as coming from the panel', async () => {
		const created = await (await upload(archive({ 'index.html': '<h1>source</h1>' }))).json();

		// Asked for by id, not "the latest": the deploy-API suite is uploading to this same
		// site in parallel, and "the latest" is whichever of us finished last.
		const one = await fetch(`${base}/api/v1/sites/${slug}/deployments/${created.deploymentId}`, {
			headers: { ...proxyHeaders(), cookie: cookieHeader() }
		}).then((res) => res.json());
		expect(one.source).toBe('panel-upload');
	});

	// This is the path a browser can be tricked into taking, so it must not work without
	// an Origin from us.
	it('refuses a cookie upload from another origin, and one with no Origin', async () => {
		const zip = archive({ 'index.html': '<h1>x</h1>' });

		const foreign = await fetch(`${base}/api/v1/sites/${slug}/deployments`, {
			method: 'POST',
			headers: {
				...proxyHeaders(),
				'content-type': 'application/zip',
				origin: 'http://evil.example.com',
				cookie: cookieHeader()
			},
			body: zip as unknown as BodyInit
		});
		expect(foreign.status).toBe(403);

		expect((await upload(zip, { withOrigin: false })).status).toBe(403);
	});

	it('refuses an anonymous upload', async () => {
		const res = await upload(archive({ 'index.html': '<h1>x</h1>' }), { withCookies: false });
		expect(res.status).toBe(401);
	});

	// PageBox deploys builds it warned about — but only once someone has said they accept
	// the consequences, and it keeps the record.
	it('requires warnings to be acknowledged, then stores them', async () => {
		const zip = archive({ 'index.html': '<script src="/app.js"></script>' });

		const unacknowledged = await upload(zip, { query: '?warnings=absolute-paths' });
		expect(unacknowledged.status).toBe(400);
		expect((await unacknowledged.json()).warnings).toContain('absolute-paths');

		const accepted = await upload(zip, { query: '?warnings=absolute-paths&acknowledged=1' });
		expect(accepted.status).toBe(201);

		const created = await accepted.json();
		const one = await fetch(`${base}/api/v1/sites/${slug}/deployments/${created.deploymentId}`, {
			headers: { ...proxyHeaders(), cookie: cookieHeader() }
		}).then((res) => res.json());
		expect(one.warnings).toContain('absolute-paths');
	});

	// Turns the warning into a fact: the page names a file the deployment does not have.
	it('reports assets the deployed page references but does not contain', async () => {
		const res = await upload(
			archive({ 'index.html': '<script src="missing.js"></script><h1>hi</h1>' })
		);
		expect(res.status).toBe(201);
		expect((await res.json()).brokenAssets).toBe(1);
	});

	// Half of what a page links to are other pages, and a page is served from <name>.html
	// or <name>/index.html — checking for a file with that exact name calls working links
	// broken, which is what a real Fumadocs export ran into.
	it('follows the resolution rules the site itself uses', async () => {
		const res = await upload(
			archive({
				'index.html':
					'<a href="docs">docs</a><a href="guide/">guide</a><a href="/s/demo-panel/api">api</a>',
				'docs.html': '<h1>docs</h1>',
				'guide/index.html': '<h1>guide</h1>',
				'api.html': '<h1>api</h1>'
			})
		);
		const body = await res.json();
		expect(body.brokenAssets, JSON.stringify(body.brokenAssetSamples)).toBe(0);
	});

	it('names what is missing, not just how many', async () => {
		const res = await upload(archive({ 'index.html': '<img src="logo.svg">' }));
		const body = await res.json();
		expect(body.brokenAssets).toBe(1);
		expect(body.brokenAssetSamples).toContain('logo.svg');
	});

	it('counts nothing broken for a complete build', async () => {
		const res = await upload(
			archive({ 'index.html': '<script src="app.js"></script>', 'app.js': 'console.log(1)' })
		);
		expect((await res.json()).brokenAssets).toBe(0);
	});
});
