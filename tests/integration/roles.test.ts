import { beforeAll, describe, expect, it } from 'vitest';
import {
	actionResult,
	configured,
	post,
	request,
	signIn,
	tag,
	userIdFor,
	type Jar
} from './helpers';

/**
 * The wall between two admins.
 *
 * `manages()` is unit-tested on its own; this is the same rule through the screens that
 * call it, because the rule only holds if *every* action goes through it. An admin who can
 * reach another admin's account can reset its password, sign in as that person, and reach
 * whatever sites they reach — so each of these is one way in, closed.
 *
 * Requires the configured account to hold the superadmin seat (`scripts/seed-demo.mjs`
 * arranges that); the suite skips the whole file otherwise.
 */

const run = configured ? describe : describe.skip;
const HANDOVER = 'handover-password-1';

run('two admins, one instance', () => {
	const mark = tag();
	const aEmail = `roles-a-${mark}@example.com`;
	const bEmail = `roles-b-${mark}@example.com`;
	const aUser = `roles-au-${mark}@example.com`;
	const bUser = `roles-bu-${mark}@example.com`;

	let seat: Jar;
	let a: Jar;
	let b: Jar;
	let aId = '';
	let bId = '';
	let aUserId = '';
	let bUserId = '';
	let seated = false;

	/** Creates an account and signs it in with its handover password already replaced. */
	async function seatAccount(who: string, role: string): Promise<Jar> {
		await post('/users?/create', seat, {
			email: who,
			name: who.split('@')[0],
			password: HANDOVER,
			role
		});
		const jar = await signIn({ email: who, password: HANDOVER });
		await post('/account/password?/changePassword', jar, {
			currentPassword: HANDOVER,
			newPassword: `chosen-${mark}-pw`,
			confirm: `chosen-${mark}-pw`
		});
		return jar;
	}

	beforeAll(async () => {
		seat = await signIn();
		const page = await (await request('/users', { jar: seat })).text();
		// Only the seat can create an admin. Without it there is nothing to test here, and
		// failing every assertion would say less than saying so once.
		seated = page.includes('?/transferSeat') || page.includes('Hand over seat');

		if (!seated) return;
		a = await seatAccount(aEmail, 'admin');
		b = await seatAccount(bEmail, 'admin');

		const after = await (await request('/users', { jar: seat })).text();
		aId = userIdFor(after, aEmail);
		bId = userIdFor(after, bEmail);

		await post('/users?/create', a, { email: aUser, password: HANDOVER });
		await post('/users?/create', b, { email: bUser, password: HANDOVER });
		aUserId = userIdFor(await (await request('/users', { jar: a })).text(), aUser);
		bUserId = userIdFor(await (await request('/users', { jar: b })).text(), bUser);
	});

	it('is running against the superadmin seat', () => {
		expect(
			seated,
			'PAGEBOX_E2E_EMAIL must hold the superadmin seat — run scripts/seed-demo.mjs'
		).toBe(true);
	});

	it('shows an admin only the accounts it issued', async () => {
		const page = await (await request('/users', { jar: a })).text();
		expect(page).toContain(aUser);
		expect(page).not.toContain(bUser);
		expect(page).not.toContain(bEmail);
	});

	it('creates plain users, whatever role the form asks for', async () => {
		const sneaky = `roles-sneaky-${mark}@example.com`;
		await post('/users?/create', a, { email: sneaky, password: HANDOVER, role: 'admin' });
		const page = await (await request('/users', { jar: a })).text();
		const row = page.split('<tr').find((chunk) => chunk.includes(sneaky)) ?? '';
		expect(row).toMatch(/>\s*user\s*</);
	});

	it('refuses one admin every way into another admin’s account', async () => {
		const reset = await actionResult(
			await post('/users?/resetPassword', a, { userId: bUserId, password: 'taken-over-1' })
		);
		expect(reset.status, 'reset').toBe(404);

		const suspend = await actionResult(await post('/users?/suspend', a, { userId: bUserId }));
		expect(suspend.status, 'suspend their user').toBe(404);

		const peer = await actionResult(await post('/users?/suspend', a, { userId: bId }));
		expect(peer.status, 'suspend the peer').toBe(404);

		const promote = await actionResult(
			await post('/users?/setRole', a, { userId: aUserId, role: 'admin' })
		);
		expect(promote.status, 'promote anyone').toBe(403);
	});

	it('lets an admin administer its own', async () => {
		const suspended = await actionResult(await post('/users?/suspend', a, { userId: aUserId }));
		expect(suspended.type).toBe('success');
		await post('/users?/restore', a, { userId: aUserId });

		const reset = await actionResult(
			await post('/users?/resetPassword', a, { userId: aUserId, password: 'a-new-handover-1' })
		);
		expect(reset.type).toBe('success');
	});

	it('keeps the seat out of reach, including from itself', async () => {
		const page = await (await request('/users', { jar: seat })).text();
		const seatRow = page.split('<tr').find((chunk) => chunk.includes('superadmin')) ?? '';
		// No id to aim at is the point: the row carries no controls at all.
		expect(seatRow).not.toContain('?/suspend');
	});

	it('walls off sites and groups the same way', async () => {
		const slug = `roles-${mark}`;
		const made = await actionResult(
			await post('/sites?/create', a, { slug, name: 'A', visibility: 'private' })
		);
		expect(made.type).toBe('redirect');

		expect(await (await request('/sites', { jar: b })).text()).not.toContain(slug);
		expect((await request(`/sites/${slug}`, { jar: b })).status).toBe(404);
		expect((await request(`/sites/${slug}`, { jar: a })).status).toBe(200);

		// The picker offers only what this admin administers, and the action re-checks it —
		// `principal` is a plain form field, not a constrained control.
		const sitePage = await (await request(`/sites/${slug}`, { jar: a })).text();
		expect(sitePage).toContain(aUser);
		expect(sitePage).not.toContain(bUser);

		const crossGrant = await actionResult(
			await post(`/sites/${slug}?/addGrant`, a, {
				principal: `user:${bUserId}`,
				role: 'viewer'
			})
		);
		expect(crossGrant.status).toBe(404);

		const groupSlug = `rg-${mark}`;
		await post('/groups?/create', a, { slug: groupSlug, name: 'A team' });
		expect(await (await request('/groups', { jar: b })).text()).not.toContain(groupSlug);

		const groupId = /name="groupId" value="([^"]+)"/.exec(
			await (await request('/groups', { jar: a })).text()
		)?.[1];
		expect(groupId).toBeTruthy();

		const intrude = await actionResult(
			await post('/groups?/addMember', b, { groupId: groupId!, userId: bUserId })
		);
		expect(intrude.status, 'B adding to A’s group').toBe(404);

		const crossMember = await actionResult(
			await post('/groups?/addMember', a, { groupId: groupId!, userId: bUserId })
		);
		expect(crossMember.status, 'A adding B’s user').toBe(404);

		const ownMember = await actionResult(
			await post('/groups?/addMember', a, { groupId: groupId!, userId: aUserId })
		);
		expect(ownMember.type).toBe('success');

		// A group is a name in a unique index; taking it back has to be possible.
		const deleted = await actionResult(
			await post('/groups?/deleteGroup', a, { groupId: groupId!, confirm: groupSlug })
		);
		expect(deleted.type).toBe('success');
		expect(await (await request('/groups', { jar: a })).text()).not.toContain(groupSlug);

		await post(`/sites/${slug}?/deleteSite`, seat, { confirm: slug });
	});

	it('shows an admin its own patch of the trail, not the instance’s', async () => {
		const mine = await (await request('/audit', { jar: a })).text();
		expect(mine).toContain('accounts you issued');
		expect(mine).not.toContain(bUser);

		const all = await (await request('/audit', { jar: seat })).text();
		expect(all).toContain('on this instance');
	});
});
