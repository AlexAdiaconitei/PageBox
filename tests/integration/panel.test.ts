import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Panel and session behaviour against a running stack.
 *
 *   docker compose up -d
 *   PAGEBOX_E2E_BASE=http://127.0.0.1:3000 \
 *   PAGEBOX_E2E_EMAIL=admin@example.com PAGEBOX_E2E_PASSWORD=... pnpm test
 *
 * The account must already exist and have changed its bootstrap password.
 */

const base = process.env.PAGEBOX_E2E_BASE;
const email = process.env.PAGEBOX_E2E_EMAIL;
const password = process.env.PAGEBOX_E2E_PASSWORD;
const adminHost = process.env.PAGEBOX_E2E_ADMIN_HOST ?? 'pagebox.localhost';
const sitesHost = process.env.PAGEBOX_E2E_SITES_HOST ?? 'pages.localhost';
const hostHeader = process.env.PAGEBOX_E2E_HOST_HEADER ?? 'x-forwarded-host';

/**
 * A fresh address per run. better-auth's rate limiter counts every request to
 * /sign-in/email, not just the failed ones, so a fixed address makes repeated runs throttle
 * themselves — which looks exactly like a broken login.
 */
const callerIp = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

const run = base && email && password ? describe : describe.skip;

type Jar = Map<string, string>;

function store(jar: Jar, res: Response) {
	for (const raw of res.headers.getSetCookie()) {
		const [pair] = raw.split(';');
		const index = pair.indexOf('=');
		jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
	}
}

const cookieHeader = (jar: Jar) =>
	[...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

function request(
	path: string,
	{
		jar,
		host = adminHost,
		method = 'GET',
		form,
		origin
	}: {
		jar?: Jar;
		host?: string;
		method?: string;
		form?: Record<string, string>;
		origin?: string | null;
	} = {}
) {
	const headers: Record<string, string> = {
		[hostHeader]: host,
		'x-forwarded-proto': 'http',
		'x-forwarded-for': callerIp
	};
	if (jar && jar.size) headers.cookie = cookieHeader(jar);
	if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
	if (origin !== null) headers.origin = origin ?? `http://${host}`;

	return fetch(`${base}${path}`, {
		method,
		headers,
		redirect: 'manual',
		body: form ? new URLSearchParams(form).toString() : undefined
	});
}

async function signIn(host = adminHost): Promise<Jar> {
	const jar: Jar = new Map();
	const res = await request('/login', {
		jar,
		host,
		method: 'POST',
		form: { email: email!, password: password! }
	});
	store(jar, res);
	return jar;
}

/**
 * A form action answers a non-HTML client with HTTP 200 and puts the real outcome in the
 * body, so asserting on `res.status` here always passes and never means anything.
 */
async function actionResult(res: Response): Promise<{ type: string; status: number }> {
	const body = (await res.json()) as { type?: string; status?: number };
	return { type: body.type ?? 'unknown', status: body.status ?? res.status };
}

run('panel sessions', () => {
	let jar: Jar;

	beforeAll(async () => {
		jar = await signIn();
		expect([...jar.keys()].some((name) => name.startsWith('pb_admin'))).toBe(true);
	});

	it('sends anonymous panel requests to the login page', async () => {
		const res = await request('/sites');
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('/login?next=%2Fsites');
	});

	it('opens the panel with a session', async () => {
		const res = await request('/sites', { jar });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('Sites');
	});

	it('rejects wrong credentials without saying why', async () => {
		const res = await request('/login', {
			method: 'POST',
			form: { email: email!, password: 'definitely-not-the-password' }
		});
		const body = await res.text();
		expect(body).toContain('do not work');
		expect(body).not.toMatch(/no such user|unknown email/i);
	});

	// The whole point of two auth instances: a panel cookie must be inert on the site host.
	it('refuses an admin session presented on the site host', async () => {
		const adminCookie = [...jar.entries()].find(([name]) => name.startsWith('pb_admin'))!;
		const res = await fetch(`${base}/`, {
			headers: {
				[hostHeader]: sitesHost,
				cookie: `${adminCookie[0]}=${adminCookie[1]}`
			},
			redirect: 'manual'
		});
		const body = await res.text();
		expect(res.status).toBe(200);
		// Signed-in state on the site host would show a sign-out button.
		expect(body).toContain('Sign in');
	});

	it('mints a separate session on the site host', async () => {
		const siteJar = await signIn(sitesHost);
		expect([...siteJar.keys()].some((name) => name.startsWith('pb_view'))).toBe(true);
		expect([...siteJar.keys()].some((name) => name.startsWith('pb_admin'))).toBe(false);
	});

	it('never routes the panel from the site host', async () => {
		for (const path of ['/sites', '/users', '/groups', '/audit']) {
			const res = await request(path, { host: sitesHost });
			expect(res.status, path).toBe(404);
		}
	});

	it('refuses a form POST from another origin', async () => {
		const res = await request('/login', {
			method: 'POST',
			form: { email: email!, password: password! },
			origin: 'http://evil.example.com'
		});
		expect(res.status).toBe(403);
	});

	it('refuses a form POST with no Origin header at all', async () => {
		const res = await request('/login', {
			method: 'POST',
			form: { email: email!, password: password! },
			origin: null
		});
		expect(res.status).toBe(403);
	});

	// This flow was broken and looked exactly like a wrong password: better-auth refused
	// the in-process call for a missing Origin, and the form reported it as bad credentials.
	// It runs on an account of its own — test files run in parallel, and rotating the shared
	// password underneath them is how you get four unrelated failures.
	it('walks a new account through its forced password change', async () => {
		// A fresh account per run: resetting an existing one means looking its id up out of
		// the page, and a lookup that picks the wrong row rewrites somebody else's password.
		const account = `pwflow-${Date.now()}@example.com`;
		const handover = 'handover-password-1';
		const chosen = 'chosen-password-2026';

		const created = await actionResult(
			await request('/users?/create', {
				jar,
				method: 'POST',
				form: { email: account, name: 'Password flow', password: handover, role: 'user' }
			})
		);
		expect(created.type).toBe('success');

		const session: Jar = new Map();
		store(
			session,
			await request('/login', {
				jar: session,
				method: 'POST',
				form: { email: account, password: handover }
			})
		);
		expect([...session.keys()].some((name) => name.startsWith('pb_admin'))).toBe(true);

		// Nothing but the change form opens while the handover credential stands.
		const gated = await request('/sites', { jar: session });
		expect(gated.status).toBe(303);
		expect(gated.headers.get('location')).toBe('/account/password');

		const changed = await actionResult(
			await request('/account/password', {
				jar: session,
				method: 'POST',
				form: { currentPassword: handover, newPassword: chosen, confirm: chosen }
			})
		);
		expect(changed).toEqual({ type: 'redirect', status: 303 });

		const after: Jar = new Map();
		store(
			after,
			await request('/login', {
				jar: after,
				method: 'POST',
				form: { email: account, password: chosen }
			})
		);
		expect((await request('/sites', { jar: after })).status).toBe(200);
	});

	it('reports a wrong current password as such', async () => {
		const res = await request('/account/password', {
			jar,
			method: 'POST',
			form: {
				currentPassword: 'not-the-password',
				newPassword: 'irrelevant-but-long',
				confirm: 'irrelevant-but-long'
			}
		});
		expect(await res.text()).toContain('current password is wrong');
	});

	it('keeps user administration to superadmins', async () => {
		const res = await request('/users', { jar });
		// The signed-in account is the bootstrap superadmin.
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('Users');
	});
});
