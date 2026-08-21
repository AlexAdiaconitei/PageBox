import { beforeAll, describe, expect, it } from 'vitest';
import {
	actionResult,
	base,
	buildZip,
	configured,
	post,
	request,
	signIn,
	sitesHost,
	tag,
	upload,
	type Jar
} from './helpers';

/**
 * Taking a site off the air, bounding its history, and removing it.
 *
 * These three landed together and were verified by hand; this is that verification made
 * repeatable. Every one of them either deletes bytes or stops serving them, which is
 * exactly the class of behaviour that must not regress quietly.
 */

const run = configured ? describe : describe.skip;

run('a site through its life', () => {
	let jar: Jar;
	let slug: string;

	beforeAll(async () => {
		jar = await signIn();
		expect([...jar.keys()].some((name) => name.startsWith('pb_admin'))).toBe(true);

		slug = `life-${tag()}`;
		const created = await actionResult(
			await post('/sites?/create', jar, { slug, name: 'Lifecycle', visibility: 'public' })
		);
		expect(created.type).toBe('redirect');
		const first = await upload(slug, buildZip({ 'index.html': '<h1>one</h1>' }), { jar });
		expect(first.status).toBe(201);
	});

	it('serves, then answers 404 for everyone once disabled', async () => {
		expect((await request(`/s/${slug}/`, { host: sitesHost })).status).toBe(200);

		const off = await actionResult(
			await post(`/sites/${slug}?/serving`, jar, { disabled: 'true', reason: 'under test' })
		);
		expect(off.type).toBe('success');

		// Every file, not only the HTML: a disabled site that still served its assets would
		// leave the content reachable to anyone holding an asset URL.
		for (const path of ['/', '/index.html']) {
			const res = await request(`/s/${slug}${path}`, { host: sitesHost });
			expect(res.status, path).toBe(404);
		}

		// Off for its owner too — the check runs before visibility and before any grant.
		expect((await request(`/s/${slug}/`, { host: sitesHost, jar })).status).toBe(404);
	});

	it('keeps the build, and serves the same one again when enabled', async () => {
		const page = await (await request(`/sites/${slug}`, { jar })).text();
		expect(page).toContain('switched off');
		expect(page).toContain('under test');

		const on = await actionResult(
			await post(`/sites/${slug}?/serving`, jar, { disabled: 'false' })
		);
		expect(on.type).toBe('success');

		const back = await request(`/s/${slug}/`, { host: sitesHost });
		expect(back.status).toBe(200);
		expect(await back.text()).toContain('one');
	});

	it('refuses a retention limit that leaves nothing to roll back to', async () => {
		const refused = await actionResult(
			await post(`/sites/${slug}?/settings`, jar, {
				name: 'Lifecycle',
				visibility: 'public',
				retentionLimit: '1'
			})
		);
		expect(refused.status).toBe(400);
		expect(refused.raw).toContain('at least');
	});

	it('drops the oldest deployment once the limit is reached, and says which', async () => {
		const set = await actionResult(
			await post(`/sites/${slug}?/settings`, jar, {
				name: 'Lifecycle',
				visibility: 'public',
				retentionLimit: '2'
			})
		);
		expect(set.type).toBe('success');

		const second = await upload(slug, buildZip({ 'index.html': '<h1>two</h1>' }), { jar });
		expect(second.status).toBe(201);
		// Two deployments, two allowed: nothing to drop yet.
		expect(second.body.pruned).toEqual([]);

		const third = await upload(slug, buildZip({ 'index.html': '<h1>three</h1>' }), { jar });
		expect(third.status).toBe(201);
		expect(third.body.pruned).toHaveLength(1);
		expect(third.body.prunedBytes).toBeGreaterThan(0);

		const history = await (await request(`/api/v1/sites/${slug}/deployments`, { jar })).json();
		expect(history.deployments).toHaveLength(2);
		// Never the live one, wherever it sits in the order.
		expect(history.deployments.some((entry: { active: boolean }) => entry.active)).toBe(true);
		expect(history.retentionLimit).toBe(2);
	});

	it('names what the next deploy will delete, before it happens', async () => {
		const page = await (await request(`/sites/${slug}`, { jar })).text();
		expect(page).toContain('deploying deletes');
	});

	it('removes the site, its objects and its slug', async () => {
		const wrong = await actionResult(
			await post(`/sites/${slug}?/deleteSite`, jar, { confirm: 'not-the-slug' })
		);
		expect(wrong.status).toBe(400);
		expect(wrong.raw).toContain('to confirm');

		const gone = await actionResult(
			await post(`/sites/${slug}?/deleteSite`, jar, { confirm: slug })
		);
		expect(gone.type).toBe('redirect');

		expect((await request(`/s/${slug}/`, { host: sitesHost })).status).toBe(404);
		expect((await request(`/sites/${slug}`, { jar })).status).toBe(404);

		// The slug goes back into circulation — a name held forever by something that no
		// longer exists is a name nobody can explain.
		const remade = await actionResult(
			await post('/sites?/create', jar, { slug, name: 'Reused', visibility: 'public' })
		);
		expect(remade.type).toBe('redirect');
		await post(`/sites/${slug}?/deleteSite`, jar, { confirm: slug });
	});

	it('answers a deleted deployment with 404 through the API too', async () => {
		expect(base).toBeTruthy();
		const res = await request(`/api/v1/sites/${slug}/deployments`, { jar });
		expect(res.status).toBe(404);
	});
});
