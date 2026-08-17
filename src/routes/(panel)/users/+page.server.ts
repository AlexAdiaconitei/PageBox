import { error, fail } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { adminAuth } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/schema';

/** User administration is superadmin-only, on the admin host only. */
function requireSuperadmin(locals: App.Locals) {
	if (locals.user?.role !== 'superadmin') error(404, 'Not found');
	return locals.user;
}

export const load: PageServerLoad = async ({ locals }) => {
	requireSuperadmin(locals);
	const rows = await db.select().from(user).orderBy(desc(user.createdAt));
	return {
		users: rows.map((row) => ({
			id: row.id,
			email: row.email,
			name: row.name,
			role: row.role,
			banned: row.banned,
			mustChangePassword: row.mustChangePassword,
			createdAt: row.createdAt,
			isSelf: row.id === locals.user!.id
		}))
	};
};

export const actions: Actions = {
	create: async (event) => {
		const actor = requireSuperadmin(event.locals);
		const data = await event.request.formData();
		const email = String(data.get('email') ?? '')
			.trim()
			.toLowerCase();
		const name = String(data.get('name') ?? '').trim() || email.split('@')[0];
		const password = String(data.get('password') ?? '');
		const role = data.get('role') === 'superadmin' ? 'superadmin' : 'user';

		if (!email.includes('@')) return fail(400, { message: 'That is not an email address' });
		if (password.length < 10) return fail(400, { message: 'Use at least 10 characters' });

		try {
			const created = await adminAuth.api.createUser({
				body: { email, password, name, role: role as 'user' },
				headers: event.request.headers
			});
			// What the superadmin typed is a handover credential, not this person's
			// password: they replace it before the panel opens for them.
			await db.update(user).set({ mustChangePassword: true }).where(eq(user.id, created.user.id));
			await audit({
				action: 'user.created',
				actorUserId: actor.id,
				targetType: 'user',
				targetId: created.user.id,
				meta: { email, role }
			});
		} catch (err) {
			const message = (err as { body?: { message?: string } })?.body?.message;
			return fail(400, { message: message ?? 'Could not create that user' });
		}

		return { message: `${email} created — hand over the temporary password` };
	},

	setRole: async (event) => {
		const actor = requireSuperadmin(event.locals);
		const data = await event.request.formData();
		const userId = String(data.get('userId') ?? '');
		const role = data.get('role') === 'superadmin' ? 'superadmin' : 'user';

		// Nobody demotes themselves out of the only superadmin seat by accident.
		if (userId === actor.id)
			return fail(400, { message: 'Change your own role from another account' });

		await adminAuth.api.setRole({
			body: { userId, role: role as 'user' },
			headers: event.request.headers
		});
		await audit({
			action: 'user.role_changed',
			actorUserId: actor.id,
			targetType: 'user',
			targetId: userId,
			meta: { role }
		});
		return { message: 'Role updated' };
	},

	ban: async (event) => {
		const actor = requireSuperadmin(event.locals);
		const data = await event.request.formData();
		const userId = String(data.get('userId') ?? '');
		const banned = data.get('banned') === 'true';
		if (userId === actor.id) return fail(400, { message: 'You cannot ban yourself' });

		if (banned) {
			await adminAuth.api.unbanUser({ body: { userId }, headers: event.request.headers });
		} else {
			await adminAuth.api.banUser({ body: { userId }, headers: event.request.headers });
		}
		await audit({
			action: banned ? 'user.unbanned' : 'user.banned',
			actorUserId: actor.id,
			targetType: 'user',
			targetId: userId
		});
		return { message: banned ? 'Access restored' : 'Access revoked' };
	},

	resetPassword: async (event) => {
		const actor = requireSuperadmin(event.locals);
		const data = await event.request.formData();
		const userId = String(data.get('userId') ?? '');
		const password = String(data.get('password') ?? '');
		if (password.length < 10) return fail(400, { message: 'Use at least 10 characters' });

		await adminAuth.api.setUserPassword({
			body: { userId, newPassword: password },
			headers: event.request.headers
		});
		await db.update(user).set({ mustChangePassword: true }).where(eq(user.id, userId));
		await audit({
			action: 'user.password_reset',
			actorUserId: actor.id,
			targetType: 'user',
			targetId: userId
		});
		return { message: 'Password replaced — they must change it at next sign-in' };
	}
};
