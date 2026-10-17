import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import {
	configured,
	signIn,
	post,
	actionResult,
	upload,
	buildZip,
	request,
	giveDomain,
	sitesHost,
	tag,
	store,
	type Jar,
	email,
	password
} from './helpers';

const run = configured ? describe : describe.skip;
const a = `isolation-a-${tag()}`;
const b = `isolation-b-${tag()}`;
let admin: Jar;
let reader: Jar;
let hostA: string;
let hostB: string;
let sql: ReturnType<typeof postgres>;
const privateAsset = (host: string, jar?: Jar, path = '/secret.txt') =>
	request(path, { host, jar, headers: { 'sec-fetch-dest': 'empty' } });
async function issue(slug: string, jar = reader) {
	const res = await request(`/access?site=${slug}&next=${encodeURIComponent('/')}`, {
		host: sitesHost,
		jar
	});
	expect(res.status).toBe(302);
	return new URL(res.headers.get('location')!);
}
async function redeem(url: URL) {
	const response = await request(url.pathname + url.search, { host: url.host });
	const jar: Jar = new Map();
	store(jar, response);
	return { response, jar };
}
run('site origin isolation', () => {
	beforeAll(async () => {
		if (process.env.PAGEBOX_DB_TESTS !== '1') throw new Error('Disposable database required');
		sql = postgres(process.env.DATABASE_URL_HOST ?? process.env.DATABASE_URL!, { max: 2 });
		admin = await signIn();
		reader = await signIn(undefined, sitesHost);
		for (const slug of [a, b]) {
			expect(
				(
					await actionResult(
						await post('/sites?/create', admin, { slug, name: slug, visibility: 'private' })
					)
				).type
			).toBe('redirect');
			expect(
				(
					await upload(
						slug,
						buildZip({
							'index.html': '<h1>isolated</h1>',
							'secret.txt': 'isolation-secret-' + slug
						}),
						{ jar: admin }
					)
				).status
			).toBe(201);
		}
		hostA = await giveDomain(admin, a);
		hostB = await giveDomain(admin, b);
	}, 20000);
	afterAll(async () => {
		await sql?.end();
	});
	it('never serves uploaded bytes on the reader login origin', async () => {
		const res = await request(`/s/${a}/secret.txt`, { host: sitesHost, jar: reader });
		expect(res.status).toBe(302);
		expect(await res.text()).not.toContain('isolation-secret');
		expect(res.headers.get('cache-control')).toBe('private, no-store');
	});
	it('does not accept central cookies on a site origin', async () => {
		expect((await privateAsset(hostA, reader)).status).toBe(401);
		// `/login` on a site's domain is a path of its build, not PageBox's sign-in form.
		const login = await request('/login', {
			host: hostA,
			headers: { 'sec-fetch-dest': 'document' }
		});
		expect(login.status).toBe(302);
		expect(new URL(login.headers.get('location')!).host).toBe(sitesHost);
	});
	it('binds each capability to one site and leaves CORS disabled', async () => {
		const { response, jar } = await redeem(await issue(a));
		expect(response.status).toBe(302);
		expect(jar.size).toBeGreaterThan(0);
		for (const cookie of response.headers.getSetCookie()) {
			expect(cookie.toLowerCase()).not.toContain('domain=');
			expect(cookie.toLowerCase()).toContain('httponly');
		}
		const own = await privateAsset(hostA, jar);
		expect(own.status).toBe(200);
		expect(await own.text()).toBe('isolation-secret-' + a);
		expect(own.headers.get('access-control-allow-origin')).toBeNull();
		expect((await privateAsset(hostB, jar)).status).toBe(401);
		expect((await privateAsset(hostA, jar, `/s/${b}/secret.txt`)).status).toBe(404);
	});
	it('rejects the wrong origin without consuming a code and rejects replay', async () => {
		const code = await issue(a);
		expect((await request(code.pathname + code.search, { host: hostB })).status).toBe(404);
		expect(
			(await request(code.pathname + code.search, { host: hostA.split(':')[0] + ':1' })).status
		).toBe(404);
		expect((await redeem(code)).response.status).toBe(302);
		expect((await redeem(code)).response.status).toBe(404);
	});
	it('allows one concurrent redemption', async () => {
		const code = await issue(a);
		const result = await Promise.all([redeem(code), redeem(code)]);
		expect(result.map((x) => x.response.status).sort()).toEqual([302, 404]);
	});
	it('rejects expired codes', async () => {
		const code = await issue(a);
		const hash = createHash('sha256').update(code.searchParams.get('code')!).digest('hex');
		await sql`update site_authorization set expires_at = now() - interval '1 minute' where code_hash = ${hash}`;
		expect((await redeem(code)).response.status).toBe(404);
	});
	it('checks authorization before forwarding an old /s/ link to the domain', async () => {
		const denied = await request(`/s/${a}/secret.txt`, {
			host: sitesHost,
			headers: { 'sec-fetch-dest': 'empty' }
		});
		expect(denied.status).toBe(401);
		expect(denied.headers.get('location')).toBeNull();
		const allowed = await request(`/s/${a}/secret.txt?x=1`, { host: sitesHost, jar: reader });
		expect(allowed.status).toBe(302);
		const location = new URL(allowed.headers.get('location')!);
		expect(location.host).toBe(sitesHost);
		expect(location.pathname).toBe('/access');
		expect(location.searchParams.get('next')).toBe('/secret.txt?x=1');
		expect(allowed.headers.get('cache-control')).toBe('private, no-store');
	});
	it('logs in and serves a private page in Chromium, while blocking cross-origin reads', async () => {
		const browser = await chromium.launch({
			headless: true,
			args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--no-proxy-server']
		});
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			await page.goto(`http://${hostA}/`);
			expect(page.url()).toContain('/login?next=');
			await page.locator('input[name=email]').fill(email!);
			await page.locator('input[name=password]').fill(password!);
			await page.locator('button[type=submit]').click();
			await page.waitForURL(`http://${hostA}/`);
			expect(await page.locator('body').textContent()).toContain('isolated');
			await page.goto(`http://${hostB}/`);
			await page.waitForURL(`http://${hostB}/`);
			const cookies = await context.cookies();
			expect(
				cookies
					.filter((c) => c.name === 'pb_site')
					.map((c) => c.domain)
					.sort()
			).toEqual([hostA.split(':')[0], hostB.split(':')[0]].sort());
			await page.goto(`http://${hostA}/`);
			const result = await page.evaluate(
				async ({ own, other }) => {
					const local = await fetch(own).then((r) => r.text());
					const cross = await fetch(other, { credentials: 'include' })
						.then((r) => r.text())
						.catch(() => 'blocked');
					return { local, cross };
				},
				{ own: '/secret.txt', other: `http://${hostB}/secret.txt` }
			);
			expect(result.local).toBe('isolation-secret-' + a);
			expect(result.cross).toBe('blocked');
		} finally {
			await browser.close();
		}
	}, 30000);
	it('revokes both a site cookie and pending authorizations on central logout', async () => {
		const cap = await redeem(await issue(a));
		const pending = await issue(b);
		expect((await post('/logout', reader, {}, sitesHost)).status).toBe(303);
		expect((await privateAsset(hostA, cap.jar)).status).toBe(401);
		expect((await redeem(pending)).response.status).toBe(404);
	});
	it('checks live grants, account bans and both session expirations on each file', async () => {
		const address = `isolated-reader-${tag()}@example.com`;
		const chosen = 'isolated-reader-password';
		expect(
			(
				await actionResult(
					await post('/users?/create', admin, { email: address, password: chosen, role: 'user' })
				)
			).type
		).toBe('success');
		const [account] = await sql`select id from "user" where email = ${address}`;
		expect(
			(
				await actionResult(
					await post(`/sites/${a}?/addGrant`, admin, {
						principal: `user:${account.id}`,
						role: 'viewer'
					})
				)
			).type
		).toBe('success');
		const viewer = await signIn({ email: address, password: chosen }, sitesHost);
		let cap = await redeem(await issue(a, viewer));
		expect((await privateAsset(hostA, cap.jar)).status).toBe(200);
		await sql`update "user" set banned = true where id = ${account.id}`;
		expect((await privateAsset(hostA, cap.jar)).status).toBe(401);
		await sql`update "user" set banned = false where id = ${account.id}`;
		await sql`update site_session set expires_at = now() - interval '1 minute' where session_id in (select id from session where user_id = ${account.id})`;
		expect((await privateAsset(hostA, cap.jar)).status).toBe(401);
		cap = await redeem(await issue(a, viewer));
		expect((await privateAsset(hostA, cap.jar)).status).toBe(200);
		const pending = await issue(a, viewer);
		const [grant] = await sql`select id from site_grant where principal_id = ${account.id}`;
		expect(
			(await actionResult(await post(`/sites/${a}?/removeGrant`, admin, { grantId: grant.id })))
				.type
		).toBe('success');
		expect((await privateAsset(hostA, cap.jar)).status).toBe(404);
		expect((await redeem(pending)).response.status).toBe(404);
		await post(`/sites/${a}?/addGrant`, admin, { principal: `user:${account.id}`, role: 'viewer' });
		cap = await redeem(await issue(a, viewer));
		await sql`update session set expires_at = now() - interval '1 minute' where user_id = ${account.id}`;
		expect((await privateAsset(hostA, cap.jar)).status).toBe(401);
	}, 20000);
	it('carries no reader cookie into a site recreated on the same domain', async () => {
		const viewer = await signIn(undefined, sitesHost);
		const cap = await redeem(await issue(a, viewer));
		expect(
			(await actionResult(await post(`/sites/${a}?/deleteSite`, admin, { confirm: a }))).type
		).toBe('redirect');
		expect(
			(
				await actionResult(
					await post('/sites?/create', admin, { slug: a, name: a, visibility: 'private' })
				)
			).type
		).toBe('redirect');
		expect((await privateAsset(hostA, cap.jar)).status).toBe(404);
		expect(await giveDomain(admin, a)).toBe(hostA);
		expect((await privateAsset(hostA, cap.jar)).status).toBe(401);
	});
});
