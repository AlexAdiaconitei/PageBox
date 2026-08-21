import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import {
	changeOwnPassword,
	refusedForCredentials,
	revokeAllSessions
} from '$lib/server/auth/credentials';
import { audit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	return { forced: locals.user?.mustChangePassword ?? false };
};

export const actions: Actions = {
	/**
	 * Ends every session on this account, including the one pressing the button.
	 *
	 * For a laptop left behind or a cookie believed copied — cases where the password is
	 * fine and there was, until now, nothing to do about it short of changing it anyway.
	 */
	signOutEverywhere: async (event) => {
		if (!event.locals.user) redirect(303, '/login');
		const result = await revokeAllSessions(event);
		if (!result.ok) {
			return fail(result.rateLimited ? 429 : 400, {
				message: result.rateLimited
					? 'Too many attempts. Try again in a few minutes.'
					: 'Could not end the other sessions — the server log has the reason'
			});
		}
		await audit({ action: 'sessions.revoked', actorUserId: event.locals.user.id });
		// Its own session went with the rest, so there is nothing to return to.
		redirect(303, '/login');
	},

	/**
	 * Named rather than `default`, because the page has two things to do now and SvelteKit
	 * refuses to mix a default action with named ones.
	 */
	changePassword: async (event) => {
		const current = event.locals.user;
		if (!current) redirect(303, '/login');

		const data = await event.request.formData();
		const currentPassword = String(data.get('currentPassword') ?? '');
		const newPassword = String(data.get('newPassword') ?? '');
		const confirm = String(data.get('confirm') ?? '');

		if (newPassword !== confirm) return fail(400, { message: 'The two new passwords differ' });
		if (newPassword.length < 10) {
			return fail(400, { message: 'Use at least 10 characters' });
		}

		// The current password is a credential too, so this goes through better-auth's
		// handler for the same throttling as sign-in.
		const result = await changeOwnPassword(event, { currentPassword, newPassword });
		if (!result.ok) {
			if (result.rateLimited) {
				return fail(429, { message: 'Too many attempts. Try again in a few minutes.' });
			}
			// Only say "wrong password" when that is what happened; the server log has the
			// reason for everything else.
			return fail(400, {
				message: refusedForCredentials(result)
					? 'The current password is wrong'
					: 'Could not change the password — the server log has the reason'
			});
		}

		// The flag is what keeps a bootstrap credential from becoming a permanent password.
		await db.update(user).set({ mustChangePassword: false }).where(eq(user.id, current.id));
		await audit({ action: 'password.changed', actorUserId: current.id });

		// A forced change is a gate: clearing it opens the panel, so go there. A voluntary
		// one is a task on this screen, and throwing the person to another one to tell them
		// it worked is how they end up wondering whether it did.
		if (current.mustChangePassword) redirect(303, '/');
		return {
			message: 'Password changed. Every other session on this account is signed out.',
			ok: true
		};
	}
};
