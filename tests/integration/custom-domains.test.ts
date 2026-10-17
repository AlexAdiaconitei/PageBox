import { beforeAll, describe, expect, it } from 'vitest';
import {
	actionResult,
	adminHost,
	buildZip,
	configured,
	giveDomain,
	post,
	request,
	signIn,
	sitesHost,
	tag,
	upload,
	type Jar
} from './helpers';

/**
 * A domain set on a site in the panel: PageBox picks the site by the Host header and
 * serves its build from `/`, so the proxy in front only has to forward the request as is.
 */
const run = configured && process.env.PAGEBOX_DB_TESTS === '1' ? describe : describe.skip;

run('custom domains', () => {
	const slug = `domain-${tag()}`;
	const other = `domain-other-${tag()}`;
	let admin: Jar;
	let domain: string;

	beforeAll(async () => {
		admin = await signIn();
		for (const name of [slug, other]) {
			expect(
				(
					await actionResult(
						await post('/sites?/create', admin, { slug: name, name, visibility: 'public' })
					)
				).type
			).toBe('redirect');
		}
		domain = await giveDomain(admin, slug);
		expect(
			(
				await upload(
					slug,
					buildZip({
						'index.html': '<link rel="stylesheet" href="/style.css"><h1>domain root</h1>',
						'style.css': 'h1{color:red}',
						'guide/index.html': 'domain guide'
					}),
					{ jar: admin }
				)
			).status
		).toBe(201);
	}, 20_000);

	it('serves the build from the root of its domain', async () => {
		const root = await request('/', { host: domain });
		expect(root.status).toBe(200);
		expect(await root.text()).toContain('domain root');
		expect((await request('/style.css', { host: domain })).status).toBe(200);
		expect(await (await request('/guide', { host: domain })).text()).toContain('domain guide');
	});

	it('keeps PageBox routes off the domain', async () => {
		expect((await request('/login', { host: domain })).status).toBe(404);
		expect((await request('/api/v1/whoami', { host: domain })).status).toBe(404);
		expect((await request('/__pb/anything', { host: domain })).status).toBe(404);
		expect((await request(`/s/${slug}/`, { host: domain })).status).toBe(404);
	});

	it('forwards old /s/<slug>/ links to the domain without the prefix', async () => {
		const moved = await request(`/s/${slug}/guide/?q=1`, { host: sitesHost });
		expect(moved.status).toBe(302);
		expect(moved.headers.get('location')).toBe(`http://${domain}/guide/?q=1`);
	});

	it('tells CI to build for / and where the site lives', async () => {
		const created = await post(`/sites/${slug}?/createToken`, admin, {
			name: 'domain-test',
			expiresInDays: '0'
		});
		const token = /pbx_[A-Za-z0-9_-]+/.exec(await created.text())?.[0];
		expect(token).toBeTruthy();
		const body = await (
			await request('/api/v1/whoami', { headers: { authorization: `Bearer ${token}` } })
		).json();
		expect(body).toMatchObject({
			basePath: '/',
			mode: 'domain',
			hostname: domain,
			siteUrl: `http://${domain}/`
		});
	});

	it('refuses a domain another site holds, or one PageBox uses itself', async () => {
		for (const hostname of [domain, adminHost, sitesHost, 'https://docs.example.com/']) {
			const result = await actionResult(await post(`/sites/${other}?/domain`, admin, { hostname }));
			expect(result.type, hostname).toBe('failure');
		}
	});

	it('goes back under /s/<slug>/ when the domain is removed', async () => {
		const result = await actionResult(
			await post(`/sites/${slug}?/domain`, admin, { hostname: '' })
		);
		expect(result.type).toBe('success');
		expect((await request('/', { host: domain })).status).toBe(404);
		// The build was made for `/`; the base path is back to the prefix and waits for a rebuild.
		expect((await request(`/s/${slug}/`, { host: sitesHost })).status).toBe(200);
		expect(await giveDomain(admin, other)).toBe(domain.replace(slug, other));
	});
});
