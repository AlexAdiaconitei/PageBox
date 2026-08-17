import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Private sites end to end: who gets bytes, who gets 404, and what an unauthenticated
 * request gets depending on whether it is a navigation or a sub-resource.
 *
 *   docker compose up -d && node scripts/seed-demo.mjs
 *   PAGEBOX_E2E_BASE=http://127.0.0.1:3000 \
 *   PAGEBOX_E2E_EMAIL=admin@example.com PAGEBOX_E2E_PASSWORD=... pnpm test
 */

const base = process.env.PAGEBOX_E2E_BASE;
const adminEmail = process.env.PAGEBOX_E2E_EMAIL;
const adminPassword = process.env.PAGEBOX_E2E_PASSWORD;
const adminHost = process.env.PAGEBOX_E2E_ADMIN_HOST ?? 'pagebox.localhost';
const sitesHost = process.env.PAGEBOX_E2E_SITES_HOST ?? 'pages.localhost';
const hostHeader = process.env.PAGEBOX_E2E_HOST_HEADER ?? 'x-forwarded-host';
const slug = `${process.env.PAGEBOX_E2E_SLUG ?? 'demo'}-private`;

const readerEmail = 'reader-e2e@example.com';
const readerPassword = 'reader-e2e-password';

const run = base && adminEmail && adminPassword ? describe : describe.skip;

type Jar = Map<string, string>;

const cookieHeader = (jar: Jar) =>
	[...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

function store(jar: Jar, res: Response) {
	for (const raw of res.headers.getSetCookie()) {
		const [pair] = raw.split(';');
		const index = pair.indexOf('=');
		jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
	}
}

function request(
	path: string,
	{
		jar,
		host = adminHost,
		method = 'GET',
		form,
		headers = {}
	}: {
		jar?: Jar;
		host?: string;
		method?: string;
		form?: Record<string, string>;
		headers?: Record<string, string>;
	} = {}
) {
	const base_headers: Record<string, string> = {
		[hostHeader]: host,
		'x-forwarded-proto': 'http',
		'x-forwarded-for': '198.51.100.12',
		origin: `http://${host}`,
		...headers
	};
	if (jar?.size) base_headers.cookie = cookieHeader(jar);
	if (form) base_headers['content-type'] = 'application/x-www-form-urlencoded';

	return fetch(`${base}${path}`, {
		method,
		headers: base_headers,
		redirect: 'manual',
		body: form ? new URLSearchParams(form).toString() : undefined
	});
}

async function signIn(email: string, password: string, host: string): Promise<Jar> {
	const jar: Jar = new Map();
	store(jar, await request('/login', { jar, host, method: 'POST', form: { email, password } }));
	return jar;
}

const asset = (path: string, jar?: Jar) =>
	request(path, { jar, host: sitesHost, headers: { 'sec-fetch-dest': 'style' } });

const navigation = (path: string, jar?: Jar) =>
	request(path, { jar, host: sitesHost, headers: { 'sec-fetch-dest': 'document' } });

run('private sites', () => {
	let admin: Jar;
	let reader: Jar;
	let readerId: string;

	async function setGrant(role: string | null) {
		const page = await request(`/sites/${slug}`, { jar: admin });
		const html = await page.text();

		if (role === null) {
			const grantId = /name="grantId" value="([^"]+)"/.exec(html)?.[1];
			if (grantId) {
				await request(`/sites/${slug}?/removeGrant`, {
					jar: admin,
					method: 'POST',
					form: { grantId }
				});
			}
			return;
		}

		await request(`/sites/${slug}?/addGrant`, {
			jar: admin,
			method: 'POST',
			form: { principal: `user:${readerId}`, role }
		});
	}

	beforeAll(async () => {
		admin = await signIn(adminEmail!, adminPassword!, adminHost);

		// Idempotent: create the reader once, then force its password so reruns work.
		await request('/users?/create', {
			jar: admin,
			method: 'POST',
			form: {
				email: readerEmail,
				name: 'Reader',
				password: readerPassword,
				role: 'user'
			}
		});

		const usersPage = await (await request('/users', { jar: admin })).text();
		expect(usersPage).toContain(readerEmail);

		const sitePage = await (await request(`/sites/${slug}`, { jar: admin })).text();
		readerId = new RegExp(`value="user:([^"]+)">${readerEmail}<`).exec(sitePage)?.[1] ?? '';
		expect(readerId).not.toBe('');

		await setGrant(null);
		reader = await signIn(readerEmail, readerPassword, sitesHost);
		expect([...reader.keys()].some((name) => name.startsWith('pb_view'))).toBe(true);
	});

	it('sends an anonymous navigation to the login page', async () => {
		const res = await navigation(`/s/${slug}/`);
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe(`/login?next=%2Fs%2F${slug}%2F`);
		expect(res.headers.get('cache-control')).toBe('private, no-store');
	});

	// A 302 answering a stylesheet or a fetch() arrives as HTML where code was expected,
	// and the page breaks in silence.
	it('answers an anonymous sub-resource with a dry 401', async () => {
		const res = await asset(`/s/${slug}/style.css`);
		expect(res.status).toBe(401);
		expect(res.headers.get('location')).toBeNull();
		expect(res.headers.get('cache-control')).toBe('private, no-store');
	});

	it('answers 404 to a signed-in reader with no grant', async () => {
		await setGrant(null);
		const res = await navigation(`/s/${slug}/`, reader);
		expect(res.status).toBe(404);
	});

	it('serves the site and every asset once a grant exists', async () => {
		await setGrant('viewer');

		const page = await navigation(`/s/${slug}/`, reader);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('demo root');

		for (const path of ['/style.css', '/assets/app-4f3a91b2.js', '/assets/logo.png']) {
			const res = await asset(`/s/${slug}${path}`, reader);
			expect(res.status, path).toBe(200);
		}
	});

	// The #1 failure mode of this design: one cached private asset at the edge and the
	// content is readable without a session.
	it('never emits a cacheable response for a private site', async () => {
		await setGrant('viewer');
		for (const path of ['/', '/style.css', '/assets/app-4f3a91b2.js', '/nope']) {
			const res = await navigation(`/s/${slug}${path}`, reader);
			expect(res.headers.get('cache-control'), path).toBe('private, no-store');
			expect(res.headers.get('cdn-cache-control'), path).toBe('no-store');
			expect(res.headers.get('vary')?.toLowerCase(), path).toContain('cookie');
		}
	});

	it('stops serving as soon as the grant is removed', async () => {
		await setGrant(null);
		expect((await navigation(`/s/${slug}/`, reader)).status).toBe(404);
		expect((await asset(`/s/${slug}/style.css`, reader)).status).toBe(404);
	});

	it('keeps the public twin unaffected', async () => {
		const res = await navigation(`/s/${process.env.PAGEBOX_E2E_SLUG ?? 'demo'}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, no-cache');
	});
});
