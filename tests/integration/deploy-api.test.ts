import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';

/**
 * Deploy API against a running stack.
 *
 *   docker compose up -d
 *   node scripts/seed-demo.mjs
 *   node scripts/create-deploy-token.mjs --site demo-api --name e2e
 *   PAGEBOX_E2E_BASE=http://127.0.0.1:3000 PAGEBOX_E2E_TOKEN=pbx_... pnpm test
 */

const base = process.env.PAGEBOX_E2E_BASE;
const token = process.env.PAGEBOX_E2E_TOKEN;
const adminHost = process.env.PAGEBOX_E2E_ADMIN_HOST ?? 'pagebox.localhost';
const sitesHost = process.env.PAGEBOX_E2E_SITES_HOST ?? 'pages.localhost';
// Its own site: these tests replace the active deployment repeatedly, and the serving
// tests read from a site that must stay put.
const slug = process.env.PAGEBOX_E2E_API_SLUG ?? `${process.env.PAGEBOX_E2E_SLUG ?? 'demo'}-api`;
const hostHeader = process.env.PAGEBOX_E2E_HOST_HEADER ?? 'x-forwarded-host';

const run = base && token ? describe : describe.skip;

const api = (path: string, init: RequestInit = {}, bearer: string | null = token!) =>
	fetch(`${base}/api/v1${path}`, {
		...init,
		redirect: 'manual',
		headers: {
			[hostHeader]: adminHost,
			...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
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

run('deploy API', () => {
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
