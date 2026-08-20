import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { signInWithPassword } from '$lib/server/auth/credentials';
import { audit } from '$lib/server/audit';
import { config } from '$lib/server/config';
import type { HostKind } from '$lib/server/config';

/**
 * One login page, two backends: the instance is chosen by the host the request arrived
 * on, so `pagebox.example.com/login` mints a panel session and `pages.example.com/login`
 * mints a read session. Two forms against the same user table is the price of not sharing
 * an origin, and it is the right trade.
 */

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) redirect(303, safeNext(url.searchParams.get('next'), locals.hostKind));
	return {
		hostKind: locals.hostKind,
		host: locals.hostKind === 'admin' ? config.PAGEBOX_ADMIN_HOST : config.PAGEBOX_SITES_HOST,
		next: url.searchParams.get('next') ?? ''
	};
};

export const actions: Actions = {
	default: async (event) => {
		const data = await event.request.formData();
		const email = String(data.get('email') ?? '')
			.trim()
			.toLowerCase();
		const password = String(data.get('password') ?? '');
		const next = safeNext(String(data.get('next') ?? ''), event.locals.hostKind);

		if (!email || !password) {
			return fail(400, { email, message: 'Email and password are required' });
		}

		const result = await signInWithPassword(event, event.locals.hostKind, { email, password });

		if (!result.ok) {
			await audit({
				action: result.rateLimited ? 'login.rate_limited' : 'login.failed',
				meta: { email, host: event.locals.hostKind },
				ip: clientIp(event)
			});
			// Same answer for "no such user", "wrong password" and "banned": the login page
			// is not an account-existence oracle. Throttling is better-auth's, applied in
			// its handler pipeline.
			return fail(result.rateLimited ? 429 : 401, {
				email,
				message: result.rateLimited
					? `Too many attempts. Try again in ${Math.max(1, Math.ceil(result.retryAfterSeconds / 60))} minute(s).`
					: 'Those credentials do not work'
			});
		}

		await audit({
			action: 'login.succeeded',
			meta: { email, host: event.locals.hostKind },
			ip: clientIp(event)
		});
		redirect(303, next);
	}
};

function clientIp(event: { getClientAddress: () => string }): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}

/**
 * Where a successful sign-in is allowed to land.
 *
 * Two rules, not one. The first is the usual: only a same-site path, because an open
 * redirect on a login page is a phishing primitive. The second is what the host kind is
 * for — the site host serves sites, so a `next` it was handed may only point at one. It
 * used to take that argument and ignore it, which left a signature promising a check that
 * was not there; the sites host would happily send a fresh viewer session at `/users` and
 * rely on the route whitelist in hooks.server.ts to 404 it. Rely on the check instead.
 */
function safeNext(value: string | null, hostKind: HostKind): string {
	const fallback = '/';
	// `//evil.com` is a protocol-relative URL, not a path; `/\evil.com` is treated as one
	// by some browsers. Both have to go before anything else looks at the string.
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
		return fallback;
	}
	if (hostKind === 'sites') {
		return value.startsWith(config.PAGEBOX_SITES_PREFIX + '/') ? value : fallback;
	}
	return value;
}
