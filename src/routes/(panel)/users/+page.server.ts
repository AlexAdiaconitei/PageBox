import { error, fail } from '@sveltejs/kit';
import { desc, eq, or } from 'drizzle-orm';
import type { Actions, PageServerLoad, RequestEvent } from './$types';
import { adminAuth, isAdmin, isSuperadmin, type SessionUser } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/schema';
import { manages } from '$lib/server/perms';

/**
 * Account administration, on the admin host only.
 *
 * Two tiers reach this page and they see different things. The superadmin sees every
 * account on the instance. An admin sees the accounts it issued and nothing else — that is
 * the whole boundary between two admins, because an admin who can reset any password can
 * sign in as anyone and walk into whichever sites that person reaches.
 *
 * Every action goes through `manages()`, never through the role alone: the role says
 * whether the page opens, `manages()` says whether this row may be touched.
 */
function requireAdmin(locals: App.Locals) {
	if (!isAdmin(locals.user)) error(404, 'Not found');
	return locals.user!;
}

/** The row behind a `userId` field, or null when the actor may not act on it. */
async function manageable(actor: SessionUser, userId: string) {
	if (!userId) return null;
	const [row] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
	if (!row || !manages(actor, row)) return null;
	return row;
}

export const load: PageServerLoad = async ({ locals }) => {
	const actor = requireAdmin(locals);

	// An admin's own row is in the list so the page shows who they are, but `manages()`
	// refuses it, so it arrives with no controls.
	const rows = isSuperadmin(actor)
		? await db.select().from(user).orderBy(desc(user.createdAt))
		: await db
				.select()
				.from(user)
				.where(or(eq(user.createdByUserId, actor.id), eq(user.id, actor.id)))
				.orderBy(desc(user.createdAt));

	return {
		actorRole: actor.role,
		canSetRoles: isSuperadmin(actor),
		users: rows.map((row) => ({
			id: row.id,
			email: row.email,
			name: row.name,
			role: row.role,
			banned: row.banned,
			mustChangePassword: row.mustChangePassword,
			createdAt: row.createdAt,
			isSelf: row.id === actor.id,
			manageable: manages(actor, row)
		}))
	};
};

/** Shared body of the `suspend` and `restore` actions. */
async function setBanned(event: RequestEvent, banned: boolean) {
	const actor = requireAdmin(event.locals);
	const data = await event.request.formData();
	const target = await manageable(actor, String(data.get('userId') ?? ''));
	if (!target) return fail(404, { message: 'That account is not yours to administer' });

	if (banned) {
		await adminAuth.api.banUser({ body: { userId: target.id }, headers: event.request.headers });
	} else {
		await adminAuth.api.unbanUser({ body: { userId: target.id }, headers: event.request.headers });
	}
	await audit({
		action: banned ? 'user.banned' : 'user.unbanned',
		actorUserId: actor.id,
		targetType: 'user',
		targetId: target.id
	});
	return { message: banned ? 'Access revoked' : 'Access restored' };
}

export const actions: Actions = {
	create: async (event) => {
		const actor = requireAdmin(event.locals);
		const data = await event.request.formData();
		const email = String(data.get('email') ?? '')
			.trim()
			.toLowerCase();
		const name = String(data.get('name') ?? '').trim() || email.split('@')[0];
		const password = String(data.get('password') ?? '');

		// Only the superadmin seats an admin, and nobody creates a second superadmin: the
		// seat is handed over, not issued. An admin's form has no role field at all, so this
		// is a floor, not a UI detail.
		const wanted = String(data.get('role') ?? 'user');
		const role = isSuperadmin(actor) && wanted === 'admin' ? 'admin' : 'user';

		if (!email.includes('@')) return fail(400, { message: 'That is not an email address' });
		if (password.length < 10) return fail(400, { message: 'Use at least 10 characters' });

		try {
			// No `role` in the body. The plugin refuses to assign one unless the caller holds
			// `set-role`, and it refuses for a role of its own `adminRoles` even then — so the
			// account is created at the plugin's default and PageBox writes the role beside
			// the two columns it already owns. Which role is decided above; the plugin has no
			// say in it, and no PageBox role needs `set-role` as a result.
			const created = await adminAuth.api.createUser({
				body: { email, password, name },
				headers: event.request.headers
			});
			await db
				.update(user)
				.set({
					role,
					// What the issuer typed is a handover credential, not this person's
					// password: they replace it before the panel opens for them.
					mustChangePassword: true,
					// Who may administer this account from here on. Written in the same breath
					// as the account, because an account with no issuer is one only the
					// superadmin can reach.
					createdByUserId: actor.id
				})
				.where(eq(user.id, created.user.id));
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

	/**
	 * Moves an account between `user` and `admin`. Superadmin only: an admin promoting
	 * someone would be minting a peer it cannot then supervise, and demoting someone would
	 * reach an account it does not administer.
	 *
	 * `superadmin` is not a value this accepts. There is one seat and it moves by
	 * `transferSeat` below, which vacates it in the same transaction that fills it.
	 */
	setRole: async (event) => {
		const actor = requireAdmin(event.locals);
		if (!isSuperadmin(actor)) return fail(403, { message: 'Not allowed' });

		const data = await event.request.formData();
		const target = await manageable(actor, String(data.get('userId') ?? ''));
		if (!target) return fail(404, { message: 'That account is not yours to administer' });

		const role = data.get('role') === 'admin' ? 'admin' : 'user';
		// Written directly, like the role on `create` and for the same reason. The guards
		// above are stricter than anything the plugin would apply — one seat, only the
		// superadmin, only a row it administers — so routing this through `setRole` would add
		// a second, weaker opinion about who may change a role, and a permission
		// (`set-role`) that no PageBox role should hold.
		await db.update(user).set({ role }).where(eq(user.id, target.id));
		await audit({
			action: 'user.role_changed',
			actorUserId: actor.id,
			targetType: 'user',
			targetId: target.id,
			meta: { role, from: target.role }
		});
		return { message: `${target.email} is now ${role}` };
	},

	/**
	 * Hands the superadmin seat to an admin, and steps down to admin in the same
	 * transaction.
	 *
	 * This exists because there is exactly one seat and a partial unique index enforcing it:
	 * without a way to move it, a superadmin who leaves the company takes the instance with
	 * them — the bootstrap env vars are inert once any account exists (see startup.ts), so
	 * there is no way back in. Two statements, one transaction: at no point are there two
	 * superadmins for the index to reject, or none for the instance to be stranded on.
	 */
	transferSeat: async (event) => {
		const actor = requireAdmin(event.locals);
		if (!isSuperadmin(actor)) return fail(403, { message: 'Not allowed' });

		const data = await event.request.formData();
		const userId = String(data.get('userId') ?? '');
		if (
			String(data.get('confirm') ?? '')
				.trim()
				.toLowerCase() !== 'transfer'
		) {
			return fail(400, { message: 'Type "transfer" to confirm' });
		}

		const [target] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
		if (!target || target.id === actor.id) {
			return fail(404, { message: 'Pick another account to hand the seat to' });
		}
		if (target.role !== 'admin') {
			return fail(400, { message: 'The seat can only go to an admin' });
		}
		if (target.banned) return fail(400, { message: 'That account is suspended' });

		await db.transaction(async (tx) => {
			// Down first: the index permits one superadmin row, so vacating before filling is
			// the only order that never collides.
			await tx.update(user).set({ role: 'admin' }).where(eq(user.id, actor.id));
			await tx.update(user).set({ role: 'superadmin' }).where(eq(user.id, target.id));
		});

		await audit({
			action: 'superadmin.transferred',
			actorUserId: actor.id,
			targetType: 'user',
			targetId: target.id,
			meta: { from: actor.email, to: target.email }
		});
		return {
			message: `${target.email} is now the superadmin. You are an admin — your sites and accounts are untouched.`
		};
	},

	/**
	 * Two actions rather than one that flips whatever it is sent.
	 *
	 * The form used to post the *current* state and the handler inverted it, so a stale page
	 * — or a value read the wrong way round once — suspends the account it meant to restore.
	 * An action named for what it does cannot be misread, and it is idempotent: pressing
	 * suspend twice suspends.
	 */
	suspend: (event) => setBanned(event, true),
	restore: (event) => setBanned(event, false),

	resetPassword: async (event) => {
		const actor = requireAdmin(event.locals);
		const data = await event.request.formData();
		const target = await manageable(actor, String(data.get('userId') ?? ''));
		if (!target) return fail(404, { message: 'That account is not yours to administer' });

		const password = String(data.get('password') ?? '');
		if (password.length < 10) return fail(400, { message: 'Use at least 10 characters' });

		await adminAuth.api.setUserPassword({
			body: { userId: target.id, newPassword: password },
			headers: event.request.headers
		});
		await db.update(user).set({ mustChangePassword: true }).where(eq(user.id, target.id));
		await audit({
			action: 'user.password_reset',
			actorUserId: actor.id,
			targetType: 'user',
			targetId: target.id
		});
		return { message: 'Password replaced — they must change it at next sign-in' };
	}
};
