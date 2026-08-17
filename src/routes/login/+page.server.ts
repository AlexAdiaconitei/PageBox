import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { authFor } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { config } from '$lib/server/config';
import { isRateLimited, recordFailedAttempt } from '$lib/server/ratelimit';

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

		// better-auth's own limiter sits in its HTTP handler, which PageBox does not mount,
		// so credential guessing is throttled here or not at all.
		const attempt = {
			scope: `login:${event.locals.hostKind}`,
			ip: clientIp(event),
			identifier: email
		};
		const limit = await isRateLimited(attempt);
		if (limit.blocked) {
			await audit({
				action: 'login.rate_limited',
				meta: { email, host: event.locals.hostKind },
				ip: clientIp(event)
			});
			return fail(429, {
				email,
				message: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`
			});
		}

		try {
			await authFor(event.locals.hostKind).api.signInEmail({
				body: { email, password },
				headers: event.request.headers
			});
		} catch (err) {
			await recordFailedAttempt(attempt);
			await audit({
				action: 'login.failed',
				meta: { email, host: event.locals.hostKind },
				ip: clientIp(event)
			});
			// Same answer for "no such user", "wrong password" and "banned": the login page
			// is not an account-existence oracle. Rate limiting lives in better-auth.
			const status = (err as { statusCode?: number })?.statusCode;
			return fail(status === 429 ? 429 : 401, {
				email,
				message:
					status === 429
						? 'Too many attempts. Wait a few minutes.'
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

/** Only same-site paths: an open redirect on a login page is a phishing primitive. */
function safeNext(value: string | null, hostKind: 'admin' | 'sites'): string {
	const fallback = '/';
	if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
	return value;
}
