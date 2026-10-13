import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { callAuthEndpoint } from '$lib/server/auth/credentials';
import { twoFactorDestination } from '$lib/server/auth/two-factor';
import { db } from '$lib/server/db';
import { session } from '$lib/server/db/schema';
import { audit } from '$lib/server/audit';

export const load: PageServerLoad = async ({ locals, url }) => {
	const next = twoFactorDestination(url.searchParams.get('next'), locals.hostKind);
	if (locals.user && locals.twoFactorVerified) redirect(303, next);
	return { next };
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const backup = form.get('method') === 'backup';
		const code = String(form.get('code') ?? '').trim();
		if (!code || (!backup && !/^\d{6}$/.test(code)))
			return fail(400, { message: 'Enter a valid code' });
		const result = await callAuthEndpoint(
			event,
			event.locals.hostKind,
			backup ? '/two-factor/verify-backup-code' : '/two-factor/verify-totp',
			{ code, trustDevice: false }
		);
		if (!result.ok) {
			await audit({
				action: 'two_factor.failed',
				actorUserId: event.locals.user?.id,
				meta: { host: event.locals.hostKind }
			});
			return fail(result.rateLimited ? 429 : 401, {
				message: result.rateLimited
					? 'Too many attempts. Try again in a few minutes.'
					: 'The code is invalid or the sign-in has expired. Try again or sign in again.'
			});
		}
		// Existing sessions can be challenged when an administrator changes the policy.
		// New challenge sessions are marked by Better Auth's session creation hook.
		if (event.locals.sessionId)
			await db
				.update(session)
				.set({ twoFactorVerified: true })
				.where(eq(session.id, event.locals.sessionId));
		await audit({
			action: 'login.succeeded',
			actorUserId:
				(result.body as { user?: { id: string } } | null)?.user?.id ?? event.locals.user?.id,
			meta: { host: event.locals.hostKind, twoFactor: true, recovery: backup }
		});
		redirect(303, twoFactorDestination(String(form.get('next') ?? ''), event.locals.hostKind));
	}
};
