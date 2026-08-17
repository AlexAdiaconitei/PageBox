import { beforeAll, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';

/**
 * Deploy API against a running stack.
 *
 *   docker compose up -d && node scripts/seed-demo.mjs
 *   PAGEBOX_E2E_BASE=http://127.0.0.1:3000  *   PAGEBOX_E2E_EMAIL=admin@example.com PAGEBOX_E2E_PASSWORD=... pnpm test
 *
 * The token is issued through the panel, the same path a person would use. Set
 * PAGEBOX_E2E_TOKEN to bring your own instead.
 */

const base = process.env.PAGEBOX_E2E_BASE;
const adminEmail = process.env.PAGEBOX_E2E_EMAIL;
const adminPassword = process.env.PAGEBOX_E2E_PASSWORD;
let token = process.env.PAGEBOX_E2E_TOKEN;
const adminHost = process.env.PAGEBOX_E2E_ADMIN_HOST ?? 'pagebox.localhost';
const sitesHost = process.env.PAGEBOX_E2E_SITES_HOST ?? 'pages.localhost';
// Its own site: these tests replace the active deployment repeatedly, and the serving
// tests read from a site that must stay put.
const slug = process.env.PAGEBOX_E2E_API_SLUG ?? `${process.env.PAGEBOX_E2E_SLUG ?? 'demo'}-api`;
const hostHeader = process.env.PAGEBOX_E2E_HOST_HEADER ?? 'x-forwarded-host';

/**
 * A fresh address per run. better-auth's rate limiter counts every request to
 * /sign-in/email, not just the failed ones, so a fixed address makes repeated runs throttle
 * themselves — which looks exactly like a broken login.
 */
const callerIp = `198.51.102.${Math.floor(Math.random() * 250) + 1}`;

const run = base && (token || (adminEmail && adminPassword)) ? describe : describe.skip;

const api = (path: string, init: RequestInit = {}, bearer: string | null | undefined = undefined) =>
	fetch(`${base}/api/v1${path}`, {
		...init,
		redirect: 'manual',
		headers: {
			[hostHeader]: adminHost,
			...(bearer === null ? {} : { authorization: `Bearer ${bearer ?? token}` }),
			...(init.headers ?? {})
		}
	});

const site = (path: string, init: RequestInit = {}) =>
	fetch(`${base}${path}`, {
		...init,
		redirect: 'manual',
		headers: { [hostHeader]: sitesHost, ...(init.headers ?? {}) }
	});

function buildZip(files: Record<string, Uint8Array | string>): Uint8Array {
	const entries: Record<string, Uint8Array> = {};
	for (const [name, content] of Object.entries(files)) {
		entries[name] = typeof content === 'string' ? strToU8(content) : content;
	}
	return zipSync(entries, { level: 9 });
}

const upload = (body: Uint8Array, query = '') =>
	api(`/sites/${slug}/deployments${query}`, {
		method: 'POST',
		headers: { 'content-type': 'application/zip', 'x-deployment-notes': 'integration test' },
		body: body as unknown as BodyInit
	});

/** Issues a deploy token the way the panel does, so the tested path is the real one. */
async function issueToken(): Promise<string> {
	const cookies = new Map<string, string>();
	const remember = (res: Response) => {
		for (const raw of res.headers.getSetCookie()) {
			const [pair] = raw.split(';');
			const index = pair.indexOf('=');
			cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
		}
	};
	const panel = (path: string, form?: Record<string, string>) =>
		fetch(`${base}${path}`, {
			method: form ? 'POST' : 'GET',
			redirect: 'manual',
			headers: {
				[hostHeader]: adminHost,
				'x-forwarded-proto': 'http',
				'x-forwarded-for': callerIp,
				origin: `http://${adminHost}`,
				cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
				...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
			},
			body: form ? new URLSearchParams(form).toString() : undefined
		});

	remember(await panel('/login', { email: adminEmail!, password: adminPassword! }));
	const created = await panel(`/sites/${slug}?/createToken`, {
		name: 'integration',
		expiresInDays: '0'
	});
	const issued = /pbx_[A-Za-z0-9_-]+/.exec(await created.text())?.[0];
	if (!issued) throw new Error('the panel did not return a deploy token');
	return issued;
}

run('deploy API', () => {
	beforeAll(async () => {
		token ??= await issueToken();
	});

	it('tells CI which base path to build for', async () => {
		const res = await api('/whoami');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.slug).toBe(slug);
		expect(body.basePath).toBe(`/s/${slug}/`);
		expect(body.mode).toBe('path');
	});

	it('refuses anonymous and malformed credentials', async () => {
		expect((await api('/whoami', {}, null)).status).toBe(401);
		expect((await api('/whoami', {}, 'pbx_not-a-real-token')).status).toBe(401);
		expect((await api('/whoami', {}, 'no-prefix')).status).toBe(401);
	});

	it('deploys a zip and serves it immediately', async () => {
		const marker = `deployed-${Date.now()}`;
		const res = await upload(
			buildZip({
				'index.html': `<!doctype html><title>t</title><h1>${marker}</h1>`,
				'assets/app-1a2b3c4d.js': 'console.log(1)'
			})
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.fileCount).toBe(2);
		expect(body.reused).toBe(false);
		expect(body.url).toContain(`/s/${slug}/`);

		expect(await (await site(`/s/${slug}/`)).text()).toContain(marker);
	});

	// `zip -r site.zip out` is what people actually run, and it puts every path under out/.
	// Deploying that verbatim gives a site whose root holds a folder and no index.html.
	it('rebases an archive that wraps everything in one directory', async () => {
		const marker = `wrapped-${Date.now()}`;
		const res = await upload(
			buildZip({
				'out/index.html': `<!doctype html><h1>${marker}</h1>`,
				'out/assets/app.js': 'console.log(1)'
			})
		);
		expect(res.status).toBe(201);

		const body = await res.json();
		expect(body.root).toBe('out');
		expect(body.fileCount).toBe(2);
		expect(await (await site(`/s/${slug}/`)).text()).toContain(marker);
		expect((await site(`/s/${slug}/assets/app.js`)).status).toBe(200);
	});

	it('leaves an archive that is already at the root alone', async () => {
		const res = await upload(buildZip({ 'index.html': '<h1>flat</h1>' }));
		expect((await res.json()).root).toBe('');
	});

	it('reuses the deployment when the same archive is uploaded again', async () => {
		const archive = buildZip({ 'index.html': '<!doctype html><h1>idempotent</h1>' });
		const first = await (await upload(archive)).json();
		const second = await (await upload(archive)).json();
		expect(second.reused).toBe(true);
		expect(second.deploymentId).toBe(first.deploymentId);
	});

	it('rejects zip-slip', async () => {
		const res = await upload(buildZip({ '../escape.txt': 'nope', 'index.html': 'ok' }));
		expect(res.status).toBe(400);
		expect((await res.json()).reason).toBe('zip-slip');
	});

	it('rejects a zip bomb by ratio', async () => {
		const bomb = new Uint8Array(8 * 1024 * 1024); // 8 MB of zeros, compresses to nothing
		const res = await upload(buildZip({ 'index.html': 'ok', 'bomb.bin': bomb }));
		expect(res.status).toBe(400);
		expect((await res.json()).reason).toBe('ratio');
	});

	it('rejects a body that is not a zip', async () => {
		const res = await upload(strToU8('this is not a zip at all'));
		expect(res.status).toBe(400);
		expect((await res.json()).reason).toBe('unreadable');
	});

	it('rejects a wrong content type', async () => {
		const res = await api(`/sites/${slug}/deployments`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		});
		expect(res.status).toBe(415);
	});

	it('lists, rolls back and refuses to delete the live deployment', async () => {
		const older = await (await upload(buildZip({ 'index.html': '<h1>older</h1>' }))).json();
		const newer = await (await upload(buildZip({ 'index.html': '<h1>newer</h1>' }))).json();

		const list = await (await api(`/sites/${slug}/deployments`)).json();
		expect(list.activeDeploymentId).toBe(newer.deploymentId);
		expect(list.deployments.map((d: { id: string }) => d.id)).toContain(older.deploymentId);

		const rollback = await api(`/sites/${slug}/deployments/${older.deploymentId}/activate`, {
			method: 'POST'
		});
		expect(rollback.status).toBe(200);
		expect(await (await site(`/s/${slug}/`)).text()).toContain('older');

		// The live deployment is the one thing that cannot be deleted.
		const live = await api(`/sites/${slug}/deployments/${older.deploymentId}`, {
			method: 'DELETE'
		});
		expect(live.status).toBe(409);

		const gone = await api(`/sites/${slug}/deployments/${newer.deploymentId}`, {
			method: 'DELETE'
		});
		expect(gone.status).toBe(200);
		expect((await api(`/sites/${slug}/deployments/${newer.deploymentId}`)).status).toBe(404);
	});

	it('hides sites the token is not scoped to, as 404', async () => {
		expect((await api('/sites/demo-private/deployments')).status).toBe(404);
		expect((await api('/sites/does-not-exist/deployments')).status).toBe(404);
	});

	it('is not reachable from the sites host', async () => {
		const res = await fetch(`${base}/api/v1/whoami`, {
			headers: { [hostHeader]: sitesHost, authorization: `Bearer ${token}` }
		});
		expect(res.status).toBe(404);
	});
});
