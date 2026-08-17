import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { authFor } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { config } from '$lib/server/config';

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

		try {
			await authFor(event.locals.hostKind).api.signInEmail({
				body: { email, password },
				headers: event.request.headers
			});
		} catch (err) {
			await audit({
				action: 'login.failed',
				meta: { email, host: event.locals.hostKind },
				ip: event.request.headers.get('x-forwarded-for')
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
			ip: event.request.headers.get('x-forwarded-for')
		});
		redirect(303, next);
	}
};

/** Only same-site paths: an open redirect on a login page is a phishing primitive. */
function safeNext(value: string | null, hostKind: 'admin' | 'sites'): string {
	const fallback = '/';
	if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
	return value;
}
