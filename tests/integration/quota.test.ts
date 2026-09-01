import { beforeAll, describe, expect, it } from 'vitest';
import {
	actionResult,
	buildOfSize,
	configured,
	post,
	request,
	signIn,
	tag,
	upload,
	userIdFor,
	type Jar
} from './helpers';

/**
 * Storage quotas, end to end.
 *
 * The pool arithmetic only exists when `PAGEBOX_STORAGE_BYTES` is declared, and quotas hold
 * either way — so the file is split: the ceiling and the refusal are always checked, the
 * pool assertions skip on an instance that has not declared one. That is not a convenience;
 * it is the documented behaviour, and running the suite both ways is how it stays true.
 */

const run = configured ? describe : describe.skip;
const HANDOVER = 'handover-password-1';
const MB = 1024 ** 2;

run('storage quotas', () => {
	const mark = tag();
	const adminEmail = `quota-${mark}@example.com`;
	const slug = `quota-${mark}`;

	let seat: Jar;
	let admin: Jar;
	let adminId = '';
	let pooled = false;

	beforeAll(async () => {
		seat = await signIn();

		const users = await (await request('/users', { jar: seat })).text();
		// "Storage" with a total means a pool was declared; without it the strip says so.
		pooled = users.includes('Allocated') && !users.includes('is unset');

		// 10 MB: small enough that a handful of megabytes crosses it, large enough to hold a
		// real build first. Written with its unit, exactly as the environment writes sizes —
		// the panel field takes the same language, which is the point of this figure.
		await post('/users?/create', seat, {
			email: adminEmail,
			name: 'Quota admin',
			password: HANDOVER,
			role: 'admin',
			quota: '10MB'
		});
		admin = await signIn({ email: adminEmail, password: HANDOVER });
		await post('/account/password?/changePassword', admin, {
			currentPassword: HANDOVER,
			newPassword: `chosen-${mark}-pw`,
			confirm: `chosen-${mark}-pw`
		});
		adminId = userIdFor(await (await request('/users', { jar: seat })).text(), adminEmail);

		await post('/sites?/create', admin, { slug, name: 'Quota', visibility: 'public' });
	});

	it('reports the allowance on the site’s history', async () => {
		const first = await upload(slug, buildOfSize(4, 'inside'), { jar: admin });
		expect(first.status).toBe(201);

		const history = await (
			await request(`/api/v1/sites/${slug}/deployments`, { jar: admin })
		).json();
		expect(history.quota.limit).toBe(10 * MB);
		expect(history.quota.used).toBeGreaterThan(0);
		expect(history.quota.remaining).toBeGreaterThan(0);
		expect(history.quota.over).toBe(false);
	});

	it('refuses a build past the ceiling, with the arithmetic, storing nothing', async () => {
		const before = await (
			await request(`/api/v1/sites/${slug}/deployments`, { jar: admin })
		).json();

		const big = await upload(slug, buildOfSize(9, 'past'), { jar: admin });
		expect(big.status).toBe(413);
		expect(big.body.reason).toBe('quota');
		expect(big.body.quota.needed).toBeGreaterThan(big.body.quota.quota - big.body.quota.used);

		// Measured off the archive's own directory before a byte is written, so the refusal
		// leaves no half-deployment behind.
		const after = await (await request(`/api/v1/sites/${slug}/deployments`, { jar: admin })).json();
		expect(after.deployments).toHaveLength(before.deployments.length);
	});

	it('counts what retention will free, so a rolling site stays deployable', async () => {
		await post(`/sites/${slug}?/settings`, admin, {
			name: 'Quota',
			visibility: 'public',
			retentionLimit: '2'
		});
		// Two more builds that would not fit if history counted against the ceiling forever.
		for (const marker of ['roll-1', 'roll-2', 'roll-3']) {
			const res = await upload(slug, buildOfSize(4, marker), { jar: admin });
			expect(res.status, marker).toBe(201);
		}
		const history = await (
			await request(`/api/v1/sites/${slug}/deployments`, { jar: admin })
		).json();
		expect(history.deployments).toHaveLength(2);
	});

	it('lets a quota be lowered below usage, and stops deploys until it is not', async () => {
		const lowered = await actionResult(
			await post('/users?/setQuota', seat, { userId: adminId, quota: '1MB' })
		);
		expect(lowered.type).toBe('success');
		expect(lowered.raw).toContain('over it');

		// Nothing was deleted and the site keeps serving — a quota is a ceiling on new
		// writes, never a delete order.
		expect((await request(`/api/v1/sites/${slug}/deployments`, { jar: admin })).status).toBe(200);

		const blocked = await upload(slug, buildOfSize(1, 'tiny'), { jar: admin });
		expect(blocked.status).toBe(413);

		await post('/users?/setQuota', seat, { userId: adminId, quota: '20MB' });
		const unblocked = await upload(slug, buildOfSize(1, 'tiny-again'), { jar: admin });
		expect(unblocked.status).toBe(201);
	});

	it('refuses a quota the pool has not got', async () => {
		if (!pooled) return; // No declared total: there is no pool to exhaust.
		const greedy = await actionResult(
			await post('/users?/setQuota', seat, { userId: adminId, quota: '999999GB' })
		);
		expect(greedy.status).toBe(409);
	});

	it('will not demote an admin who still owns sites, and transfers instead', async () => {
		const refused = await actionResult(
			await post('/users?/setRole', seat, { userId: adminId, role: 'user' })
		);
		expect(refused.status).toBe(409);
		expect(refused.raw).toContain(slug);

		const heirEmail = `quota-heir-${mark}@example.com`;
		await post('/users?/create', seat, {
			email: heirEmail,
			password: HANDOVER,
			role: 'admin',
			quota: '1GB'
		});
		const heirId = userIdFor(await (await request('/users', { jar: seat })).text(), heirEmail);

		const moved = await actionResult(
			await post(`/sites/${slug}?/transferSite`, seat, { ownerUserId: heirId })
		);
		expect(moved.type).toBe('success');

		const demoted = await actionResult(
			await post('/users?/setRole', seat, { userId: adminId, role: 'user' })
		);
		expect(demoted.type).toBe('success');

		// The bytes moved with the site: the demoted account holds no quota and no storage.
		const page = await (await request('/users', { jar: seat })).text();
		const heirRow = page.split('<tr').find((chunk) => chunk.includes(heirEmail)) ?? '';
		expect(heirRow).toMatch(/[\d.]+ [KMG]B \/ 1 GB/);

		await post(`/sites/${slug}?/deleteSite`, seat, { confirm: slug });
	});
});
