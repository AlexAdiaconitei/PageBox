import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { adminAuth } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals }) => {
	return { forced: locals.user?.mustChangePassword ?? false };
};

export const actions: Actions = {
	default: async (event) => {
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

		try {
			await adminAuth.api.changePassword({
				body: { currentPassword, newPassword, revokeOtherSessions: true },
				headers: event.request.headers
			});
		} catch {
			return fail(400, { message: 'The current password is wrong' });
		}

		// The flag is what keeps a bootstrap credential from becoming a permanent password.
		await db.update(user).set({ mustChangePassword: false }).where(eq(user.id, current.id));
		await audit({ action: 'password.changed', actorUserId: current.id });

		redirect(303, '/');
	}
};
