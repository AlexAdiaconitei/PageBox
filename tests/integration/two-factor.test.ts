import { createHmac } from 'node:crypto';
import { parse } from 'devalue';
import postgres from 'postgres';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	actionResult,
	adminHost,
	configured,
	email,
	password,
	request,
	signIn,
	giveDomain,
	sitesHost,
	store,
	tag,
	userIdFor,
	type Jar
} from './helpers';

const run = configured && process.env.PAGEBOX_DB_TESTS === '1' ? describe : describe.skip;
const chosen = 'two-factor-fixture-password';

// Generate RFC 6238 codes independently of the authentication implementation.
function totp(secret: string): string {
	const bits = [...secret]
		.map((char) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5, '0'))
		.join('');
	const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
	const digest = createHmac('sha1', key).update(counter).digest();
	const offset = digest[digest.length - 1] & 15;
	return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

let address = 0;
async function submit(
	path: string,
	jar: Jar,
	form: Record<string, string>,
	host = adminHost,
	fixedIp?: string
) {
	const res = await request(path, {
		jar,
		host,
		method: 'POST',
		form,
		headers: { 'x-forwarded-for': fixedIp ?? `192.0.2.${++address}` }
	});
	store(jar, res);
	return res;
}

async function enrollment(jar: Jar, credential: string, host = adminHost) {
	const res = await submit('/two-factor/setup?/enable', jar, { password: credential }, host);
	expect(res.headers.get('cache-control')).toContain('no-store');
	const action = await res.json();
	expect(action.type).toBe('success');
	const data = parse(action.data) as { secret: string; qr: string; backupCodes: string[] };
	expect(data.qr).toMatch(/^data:image\/png;base64,/);
	expect(data.backupCodes).toHaveLength(10);
	return data;
}

run('authenticator and mandatory two-factor policy', () => {
	let seat: Jar;
	let reader: { email: string; jar: Jar; id: string };
	let authenticator: Awaited<ReturnType<typeof enrollment>>;
	let slug: string;
	let domain: string;
	let fixture: ReturnType<typeof postgres>;
	beforeAll(async () => {
		fixture = postgres(process.env.DATABASE_URL_HOST ?? process.env.DATABASE_URL!, { max: 1 });
		seat = await signIn();
		expect((await request('/security', { jar: seat })).status).toBe(200);
		const accountEmail = `two-factor-${tag()}@example.com`;
		expect(
			(
				await actionResult(
					await submit('/users?/create', seat, {
						email: accountEmail,
						password: chosen,
						role: 'user'
					})
				)
			).type
		).toBe('success');
		const id = userIdFor(await (await request('/users', { jar: seat })).text(), accountEmail);
		const jar = await signIn({ email: accountEmail, password: chosen });
		await submit('/account/password?/changePassword', jar, {
			currentPassword: chosen,
			newPassword: chosen + '-changed',
			confirm: chosen + '-changed'
		});
		reader = { email: accountEmail, jar, id };
		slug = 'two-factor-' + tag();
		await submit('/sites?/create', seat, { slug, name: slug, visibility: 'private' });
		await submit(`/sites/${slug}?/addGrant`, seat, { principal: `user:${id}`, role: 'viewer' });
		domain = await giveDomain(seat, slug);
	}, 30_000);

	afterAll(async () => {
		if (seat) {
			await submit('/security', seat, { required: 'false' });
			await submit('/two-factor/setup?/disable', seat, { password: password! });
		}
		await fixture?.end();
	});

	it('requires the superadmin to enroll before making 2FA mandatory and denies other roles', async () => {
		expect((await actionResult(await submit('/security', seat, { required: 'true' }))).status).toBe(
			400
		);
		expect((await request('/security', { jar: reader.jar })).status).toBe(404);
		expect(
			(await actionResult(await submit('/security', reader.jar, { required: 'true' }))).status
		).toBe(404);
	});

	it('keeps enrollment inactive until a real authenticator code is verified and revokes older sessions', async () => {
		const old = await signIn();
		authenticator = await enrollment(seat, password!);
		const unverified = await signIn();
		expect((await request('/security', { jar: unverified })).status).toBe(200);
		expect(
			(
				await actionResult(
					await submit('/two-factor/setup?/verify', seat, {
						code: totp(authenticator.secret),
						saved: 'yes'
					})
				)
			).type
		).toBe('success');
		expect((await request('/security', { jar: seat })).status).toBe(200);
		expect((await request('/security', { jar: old })).headers.get('location')).toMatch(/^\/login/);
	});

	it('challenges password sign-in on both hosts and accepts real TOTP codes without sharing cookies', async () => {
		for (const host of [adminHost, sitesHost]) {
			const jar: Jar = new Map();
			const login = await submit(
				'/login',
				jar,
				{
					email: email!,
					password: password!,
					next: host === adminHost ? '/security' : '/access?site=' + slug
				},
				host
			);
			const loginResult = await login.json();
			expect(loginResult.location).toMatch(/^\/two-factor\?next=/);
			expect(
				(
					await request(host === adminHost ? '/security' : '/access?site=' + slug, { jar, host })
				).headers.get('location')
			).toMatch(/^\/login/);
			expect(
				(
					await actionResult(
						await submit('/two-factor', jar, { code: totp(authenticator.secret), next: '/' }, host)
					)
				).type
			).toBe('redirect');
			expect((await request('/two-factor/setup', { jar, host })).status).toBe(200);
			const wrongHost = host === adminHost ? sitesHost : adminHost;
			expect((await request('/two-factor/setup', { jar, host: wrongHost })).status).not.toBe(200);
		}
	});

	it('accepts a recovery code once and refuses replay', async () => {
		const jar = await signIn();
		expect(
			(
				await actionResult(
					await submit('/two-factor', jar, { method: 'backup', code: authenticator.backupCodes[0] })
				)
			).type
		).toBe('redirect');
		const replay = await signIn();
		expect(
			(
				await actionResult(
					await submit('/two-factor', replay, {
						method: 'backup',
						code: authenticator.backupCodes[0]
					})
				)
			).status
		).toBe(401);
	});

	it('challenges an existing session without 2FA proof and preserves proof through password rotation', async () => {
		const jar = await signIn();
		await submit('/two-factor', jar, { code: totp(authenticator.secret) });
		await fixture`update session set two_factor_verified = false where user_id = (select id from "user" where email = ${email!})`;
		expect((await request('/security', { jar })).headers.get('location')).toMatch(
			/^\/two-factor\?next=/
		);
		expect((await request('/api/v1/whoami', { jar })).status).toBe(403);
		expect(
			(
				await actionResult(
					await submit('/two-factor', jar, { code: totp(authenticator.secret), next: '/security' })
				)
			).type
		).toBe('redirect');
		expect((await request('/security', { jar })).status).toBe(200);
		// Restore the main fixture session too, before later policy changes.
		await submit('/two-factor', seat, { code: totp(authenticator.secret) });
		const changed = password! + '-rotation';
		expect(
			(
				await actionResult(
					await submit('/account/password?/changePassword', jar, {
						currentPassword: password!,
						newPassword: changed,
						confirm: changed
					})
				)
			).type
		).toBe('success');
		expect((await request('/security', { jar })).status).toBe(200);
		await submit('/account/password?/changePassword', jar, {
			currentPassword: changed,
			newPassword: password!,
			confirm: password!
		});
		seat = jar;
	});

	it('throttles verification through Better Auth and rejects cross-origin submissions', async () => {
		const jar = await signIn();
		const outcomes = [];
		for (let attempt = 0; attempt < 4; attempt++)
			outcomes.push(
				await actionResult(
					await submit(
						'/two-factor',
						jar,
						{ method: 'backup', code: 'invalid-recovery-code' },
						adminHost,
						'192.0.2.240'
					)
				)
			);
		expect(outcomes.at(-1)?.status).toBe(429);
		expect(
			(
				await request('/two-factor', {
					jar,
					method: 'POST',
					origin: 'https://evil.example',
					form: { code: totp(authenticator.secret) }
				})
			).status
		).toBe(403);
	});

	it('gates existing unconfigured sessions and private site capabilities when the policy becomes required', async () => {
		const view = await signIn({ email: reader.email, password: chosen + '-changed' }, sitesHost);
		const issued = await request('/access?site=' + slug, { jar: view, host: sitesHost });
		expect(issued.status).toBe(302);
		const capability = new URL(issued.headers.get('location')!);
		const child: Jar = new Map();
		const accepted = await request(capability.pathname + capability.search, {
			host: capability.host
		});
		store(child, accepted);
		expect(accepted.status).toBe(302);
		expect((await actionResult(await submit('/security', seat, { required: 'true' }))).type).toBe(
			'success'
		);
		expect((await request('/sites', { jar: reader.jar })).headers.get('location')).toMatch(
			/^\/two-factor\/setup/
		);
		expect((await request('/api/v1/whoami', { jar: reader.jar })).status).toBe(403);
		expect(
			(await request('/access?site=' + slug, { jar: view, host: sitesHost })).headers.get(
				'location'
			)
		).toMatch(/^\/two-factor\/setup/);
		expect(
			(
				await request('/', {
					jar: child,
					host: domain,
					headers: { 'sec-fetch-dest': 'style' }
				})
			).status
		).toBe(401);
	});

	it('enforces enrollment on the reader host and prohibits disabling required authenticators', async () => {
		const management = await (await request('/two-factor/setup', { jar: seat })).text();
		expect(management).toContain('Manage authenticator');
		expect(management).not.toContain('formaction="?/disable"');
		const view = await signIn({ email: reader.email, password: chosen + '-changed' }, sitesHost);
		const data = await enrollment(view, chosen + '-changed', sitesHost);
		expect(
			(
				await actionResult(
					await submit(
						'/two-factor/setup?/verify',
						view,
						{ code: totp(data.secret), saved: 'yes' },
						sitesHost
					)
				)
			).type
		).toBe('success');
		expect((await request('/access?site=' + slug, { jar: view, host: sitesHost })).status).toBe(
			302
		);
		expect(
			(
				await actionResult(
					await submit(
						'/two-factor/setup?/disable',
						view,
						{ password: chosen + '-changed' },
						sitesHost
					)
				)
			).status
		).toBe(403);
		expect(
			(
				await actionResult(
					await submit('/two-factor/setup?/disable', seat, { password: password! })
				)
			).status
		).toBe(403);
	});

	it('keeps password replacement accessible before mandatory enrollment for newly issued accounts', async () => {
		const accountEmail = `mandatory-${tag()}@example.com`;
		await submit('/users?/create', seat, { email: accountEmail, password: chosen, role: 'user' });
		const jar = await signIn({ email: accountEmail, password: chosen });
		expect((await request('/two-factor/setup', { jar })).headers.get('location')).toBe(
			'/account/password'
		);
		expect((await request('/account/password', { jar })).status).toBe(200);
		expect(
			(
				await actionResult(
					await submit('/account/password?/changePassword', jar, {
						currentPassword: chosen,
						newPassword: chosen + '-changed',
						confirm: chosen + '-changed'
					})
				)
			).type
		).toBe('redirect');
		expect((await request('/sites', { jar })).headers.get('location')).toMatch(
			/^\/two-factor\/setup/
		);
		expect((await request('/two-factor/setup', { jar })).status).toBe(200);
	});

	it('replaces recovery codes and preserves voluntary 2FA when the policy returns to optional', async () => {
		const regenerated = await submit('/two-factor/setup?/regenerate', seat, {
			password: password!
		});
		const body = await regenerated.json();
		expect(body.type).toBe('success');
		const replacement = parse(body.data) as { backupCodes: string[] };
		expect(replacement.backupCodes).toHaveLength(10);
		const jar = await signIn();
		expect(
			(
				await actionResult(
					await submit('/two-factor', jar, { method: 'backup', code: authenticator.backupCodes[1] })
				)
			).status
		).toBe(401);
		expect(
			(
				await actionResult(
					await submit('/two-factor', jar, { method: 'backup', code: replacement.backupCodes[0] })
				)
			).type
		).toBe('redirect');
		expect((await actionResult(await submit('/security', seat, { required: 'false' }))).type).toBe(
			'success'
		);
		expect((await request('/two-factor/setup', { jar: seat })).status).toBe(200);
		const login = await submit('/login', new Map(), { email: email!, password: password! });
		expect((await login.json()).location).toMatch(/^\/two-factor/);
	});

	it('enrolls, challenges and manages 2FA with one password field in Chromium', async () => {
		const accountEmail = `browser-two-factor-${tag()}@example.com`;
		await submit('/users?/create', seat, { email: accountEmail, password: chosen, role: 'user' });
		const jar = await signIn({ email: accountEmail, password: chosen });
		await submit('/account/password?/changePassword', jar, {
			currentPassword: chosen,
			newPassword: chosen + '-changed',
			confirm: chosen + '-changed'
		});
		const browser = await chromium.launch({
			headless: true,
			timeout: 5000,
			args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--no-proxy-server']
		});
		try {
			const context = await browser.newContext({
				viewport: { width: 390, height: 844 },
				colorScheme: 'light'
			});
			await context.addCookies(
				[...jar]
					.filter(([name, value]) => value && name.includes('session_token'))
					.map(([name, value]) => ({ name, value, url: 'http://' + adminHost }))
			);
			const page = await context.newPage();
			page.setDefaultTimeout(5000);
			page.setDefaultNavigationTimeout(5000);
			await page.goto('http://' + adminHost + '/two-factor/setup');
			await page.locator('input[name=password]').fill(chosen + '-changed');
			const [setupResponse] = await Promise.all([
				page.waitForResponse((response) => response.request().method() === 'POST'),
				page.getByRole('button', { name: 'Set up authenticator', exact: true }).click()
			]);
			expect(setupResponse.status()).toBe(200);
			await page.getByAltText('Scan this QR code with your authenticator app').waitFor();
			expect(await page.locator('input[name=password]:visible').count()).toBe(0);
			await page.getByText('Restart setup', { exact: true }).click();
			expect(await page.locator('input[name=password]:visible').count()).toBe(1);
			await page.getByText('Restart setup', { exact: true }).click();
			expect(await page.locator('.notice-info').count()).toBeGreaterThan(0);
			const icon = await request('/icon-192.png');
			expect(icon.status).toBe(200);
			expect(icon.headers.get('content-type')).toContain('image/png');
			const secret = (await page.locator('code').innerText()).trim();
			expect(await page.locator('main').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
				true
			);
			await page.locator('input[name=code]').fill(totp(secret));
			const savedLabel = page.locator('label').filter({ has: page.locator('input[name=saved]') });
			const savedAlignment = await savedLabel.evaluate((label) => {
				const checkbox = label.querySelector('input')!.getBoundingClientRect();
				const range = document.createRange();
				const text = Array.from(label.childNodes).find(
					(node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
				);
				const span = label.querySelector('span');
				if (span) range.selectNodeContents(span);
				else range.selectNodeContents(text!);
				const line = range.getBoundingClientRect();
				return Math.abs(checkbox.y + checkbox.height / 2 - (line.y + line.height / 2));
			});
			expect(savedAlignment).toBeLessThanOrEqual(2);
			await page.locator('input[name=saved]').check();
			expect(
				await page.locator('form[action="?/verify"]').evaluate((form) =>
					Array.from((form as HTMLFormElement).elements)
						.filter((element) => element instanceof HTMLInputElement && !element.validity.valid)
						.map((element) => {
							const input = element as HTMLInputElement;
							return {
								name: input.name,
								length: input.value.length,
								missing: input.validity.valueMissing,
								pattern: input.validity.patternMismatch
							};
						})
				)
			).toEqual([]);
			const [verifiedResponse] = await Promise.all([
				page.waitForResponse((response) => response.request().method() === 'POST'),
				page.getByRole('button', { name: 'Verify and enable', exact: true }).click()
			]);
			expect(verifiedResponse.status()).toBe(200);
			try {
				await page.getByRole('heading', { name: 'Manage authenticator', exact: true }).waitFor();
			} catch (error) {
				throw new Error(
					`Enrollment confirmation failed at ${page.url()}: ${(await page.locator('.notice').allTextContents()).join(' ')}`,
					{ cause: error }
				);
			}
			const success = page
				.getByRole('status')
				.filter({ hasText: 'Two-factor authentication is enabled.' });
			expect(await success.getAttribute('class')).toContain('notice-ok');
			expect(await page.locator('input[name=password]').count()).toBe(1);
			const successColors = await success.evaluate((element) => ({
				border: getComputedStyle(element).borderLeftColor,
				background: getComputedStyle(element).backgroundColor
			}));
			await page.emulateMedia({ colorScheme: 'dark' });
			expect(
				await success.evaluate((element) => getComputedStyle(element).borderLeftColor)
			).not.toBe(successColors.border);
			await page.getByRole('button', { name: 'Sign out', exact: true }).click();
			await page.goto('http://' + adminHost + '/login');
			await page.locator('input[name=email]').fill(accountEmail);
			await page.locator('input[name=password]').fill(chosen + '-changed');
			await page.getByRole('button', { name: 'Sign in', exact: true }).click();
			await page.waitForURL('**/two-factor?**');
			await page.locator('input[name=code]').fill(totp(secret));
			await page.getByRole('button', { name: 'Verify and continue', exact: true }).click();
			await page.waitForURL('**/sites');
			await page.goto('http://' + adminHost + '/two-factor/setup');
			expect(await page.locator('input[name=password]').count()).toBe(1);
			await page.locator('input[name=password]').fill(chosen + '-changed');
			const [regeneratedResponse] = await Promise.all([
				page.waitForResponse((response) => response.request().method() === 'POST'),
				page.getByRole('button', { name: 'Replace recovery codes', exact: true }).click()
			]);
			expect(regeneratedResponse.url()).toContain('?/regenerate');
			expect(regeneratedResponse.status()).toBe(200);
			await page.getByRole('heading', { name: 'Recovery codes', exact: true }).waitFor();
			expect(await page.locator('section ul li').count()).toBe(10);
			expect(await page.locator('input[name=password]').count()).toBe(1);
			await page.locator('input[name=password]').fill(chosen + '-changed');
			const [disabledResponse] = await Promise.all([
				page.waitForResponse((response) => response.request().method() === 'POST'),
				page.getByRole('button', { name: 'Disable two-factor authentication', exact: true }).click()
			]);
			expect(disabledResponse.url()).toContain('?/disable');
			expect(disabledResponse.status()).toBe(200);
			await page.getByRole('button', { name: 'Set up authenticator', exact: true }).waitFor();
			expect(
				await page.getByRole('heading', { name: 'Manage authenticator', exact: true }).count()
			).toBe(0);
		} finally {
			await browser.close();
		}
	}, 30_000);
});
