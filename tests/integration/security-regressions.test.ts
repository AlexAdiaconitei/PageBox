import { beforeAll, describe, expect, it } from 'vitest';
import {
	actionResult,
	buildZip,
	configured,
	post,
	request,
	signIn,
	sitesHost,
	tag,
	upload,
	userIdFor,
	store,
	siteHost,
	type Jar
} from './helpers';

const run = configured ? describe : describe.skip;
const temporary = 'temporary-password-123';
const chosen = 'chosen-password-456';

run('security regressions', () => {
	let seat: Jar;
	beforeAll(async () => {
		seat = await signIn();
		expect(seat.size).toBeGreaterThan(0);
	});

	async function create(issuer: Jar, role = 'user', change = true) {
		const email = `security-${tag()}@example.com`;
		const created = await actionResult(
			await post('/users?/create', issuer, {
				email,
				password: temporary,
				role,
				quota: '5MB'
			})
		);
		expect(created.type).toBe('success');
		const id = userIdFor(await (await request('/users', { jar: seat })).text(), email);
		expect(id).toBeTruthy();
		const jar = await signIn({ email, password: temporary });
		expect(jar.size).toBeGreaterThan(0);
		if (change) {
			const changed = await actionResult(
				await post('/account/password?/changePassword', jar, {
					currentPassword: temporary,
					newPassword: chosen,
					confirm: chosen
				})
			);
			expect(['success', 'redirect']).toContain(changed.type);
		}
		return { id, jar, email };
	}

	it('preserves HTTP cookie attributes when copying the authentication response', async () => {
		const response = await request('/login', {
			method: 'POST',
			form: { email: (await create(seat, 'user', false)).email, password: temporary }
		});
		expect((await actionResult(response)).type).toBe('redirect');
		const cookies = response.headers.getSetCookie();
		expect(cookies.length).toBeGreaterThan(0);
		for (const cookie of cookies) {
			expect(cookie.toLowerCase()).not.toMatch(/;\s*secure(?:;|$)/);
			expect(cookie.toLowerCase()).toContain('; httponly');
		}
	});

	it('rejects unknown grant roles and invalid token expiry instead of storing them', async () => {
		const slug = `validation-${tag()}`;
		await post('/sites?/create', seat, { slug, name: slug, visibility: 'private' });
		const target = await create(seat);
		const grant = await actionResult(
			await post(`/sites/${slug}?/addGrant`, seat, {
				principal: `user:${target.id}`,
				role: 'invalid-role'
			})
		);
		expect(grant.status).toBe(400);
		for (const days of ['-1', 'NaN', '366', '0.5']) {
			const token = await actionResult(
				await post(`/sites/${slug}?/createToken`, seat, {
					name: 'invalid-expiry',
					expiresInDays: days
				})
			);
			expect(token.status, days).toBe(400);
		}
	}, 30_000);

	it('keeps the forced password gate when the temporary password is reused', async () => {
		const admin = await create(seat, 'admin', false);
		const unchanged = await actionResult(
			await post('/account/password?/changePassword', admin.jar, {
				currentPassword: temporary,
				newPassword: temporary,
				confirm: temporary
			})
		);
		expect(unchanged.type).toBe('failure');
		expect(unchanged.status).toBe(400);
		expect((await request('/sites', { jar: admin.jar })).headers.get('location')).toBe(
			'/account/password'
		);
	}, 30_000);

	it('refuses the issuer reset and suspension after promotion', async () => {
		const admin = await create(seat, 'admin');
		const target = await create(admin.jar);
		const promoted = await actionResult(
			await post('/users?/setRole', seat, {
				userId: target.id,
				role: 'admin'
			})
		);
		expect(promoted.type).toBe('success');
		for (const action of ['resetPassword', 'suspend']) {
			const refused = await actionResult(
				await post(`/users?/${action}`, admin.jar, {
					userId: target.id,
					password: 'takeover-password-789'
				})
			);
			expect(refused.status).toBe(404);
		}
		const login = await signIn({ email: target.email, password: 'takeover-password-789' });
		expect(login.size).toBe(0);
	}, 30_000);

	it('revokes old sessions and tokens, then gates a temporary-password session at the API', async () => {
		const admin = await create(seat, 'admin');
		const slug = `reset-${tag()}`;
		expect(
			(
				await actionResult(
					await post('/sites?/create', admin.jar, {
						slug,
						name: slug,
						visibility: 'private'
					})
				)
			).type
		).toBe('redirect');
		expect(
			(await upload(slug, buildZip({ 'index.html': 'private-reset-fixture' }), { jar: admin.jar }))
				.status
		).toBe(201);
		const reader = await signIn({ email: admin.email, password: chosen }, sitesHost);
		expect(reader.size).toBeGreaterThan(0);
		const issue = async () => {
			const response = await request(`/access?site=${slug}`, { jar: reader, host: sitesHost });
			expect(response.status).toBe(302);
			return new URL(response.headers.get('location')!);
		};
		const code = await issue();
		const capability: Jar = new Map();
		store(capability, await request(code.pathname + code.search, { host: code.host }));
		expect(capability.size).toBeGreaterThan(0);
		const child = (await siteHost(slug))!;
		expect((await request(`/s/${slug}/index.html`, { host: child, jar: capability })).status).toBe(
			200
		);
		const pending = await issue();
		const issued = await post(`/sites/${slug}?/createToken`, admin.jar, {
			name: 'reset-test',
			expiresInDays: '0'
		});
		const token = /pbx_[A-Za-z0-9_-]+/.exec(await issued.text())?.[0];
		expect(token).toBeTruthy();
		expect(
			(await request('/api/v1/whoami', { headers: { authorization: `Bearer ${token}` } })).status
		).toBe(200);
		expect(
			(
				await actionResult(
					await post('/users?/resetPassword', seat, {
						userId: admin.id,
						password: temporary
					})
				)
			).type
		).toBe('success');
		expect((await request(`/api/v1/sites/${slug}/deployments`, { jar: admin.jar })).status).toBe(
			401
		);
		expect((await request(`/s/${slug}/`, { jar: reader, host: sitesHost })).status).toBe(401);
		expect((await request(`/s/${slug}/index.html`, { host: child, jar: capability })).status).toBe(
			401
		);
		expect((await request(pending.pathname + pending.search, { host: pending.host })).status).toBe(
			404
		);
		expect(
			(await request('/api/v1/whoami', { headers: { authorization: `Bearer ${token}` } })).status
		).toBe(401);
		const fresh = await signIn({ email: admin.email, password: temporary });
		expect((await request(`/api/v1/sites/${slug}/deployments`, { jar: fresh })).status).toBe(403);
		expect((await upload(slug, buildZip({ 'index.html': 'blocked' }), { jar: fresh })).status).toBe(
			403
		);
		expect((await request('/sites', { jar: fresh })).headers.get('location')).toBe(
			'/account/password'
		);
	}, 30_000);

	it('rejects forged Bearer exemptions on panel actions and never falls back to a cookie on the API', async () => {
		const admin = await create(seat, 'admin');
		const slug = `csrf-${tag()}`;
		await post('/sites?/create', admin.jar, { slug, name: slug, visibility: 'public' });
		const blocked = await request(`/sites/${slug}?/serving`, {
			jar: admin.jar,
			method: 'POST',
			origin: 'http://evil.test',
			headers: { authorization: 'Bearer bogus' },
			form: { disabled: 'true' }
		});
		expect(blocked.status).toBe(403);
		const api = await request(`/api/v1/sites/${slug}/deployments`, {
			jar: admin.jar,
			headers: { authorization: 'Bearer bogus' }
		});
		expect(api.status).toBe(401);
	}, 30_000);
});
