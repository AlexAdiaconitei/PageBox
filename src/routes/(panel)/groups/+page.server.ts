import { error, fail } from '@sveltejs/kit';
import { and, eq, or } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { isAdmin, isSuperadmin, type SessionUser } from '$lib/server/auth';
import { audit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { group, groupMember, user } from '$lib/server/db/schema';
import { isValidSlug, newId } from '$lib/server/ids';
import { hasOperatorAccess, invalidateUserGroups, manages } from '$lib/server/perms';

/**
 * Groups, and who owns one.
 *
 * A group is a shortcut for granting access, so whoever can change its membership can
 * change who reaches every site it has been granted on. Left global — as it was — an admin
 * could add their own people to another admin's group and walk straight into their sites,
 * which is the same hole `created_by_user_id` closes on accounts. So a group belongs to the
 * admin who made it: they are the only one who lists it, changes it, or grants on it, and
 * the superadmin sees all of them.
 *
 * Members are constrained twice over: the group has to be yours, *and* the person has to be
 * an account you administer. Either alone leaves a way to move somebody else's user into a
 * membership that grants them something.
 */
function requireAdmin(locals: App.Locals) {
	if (!isAdmin(locals.user)) error(404, 'Not found');
	return locals.user!;
}

/** The group behind a `groupId` field, or null when it is not the actor's to change. */
async function ownedGroup(actor: SessionUser, groupId: string) {
	if (!groupId) return null;
	const [row] = await db.select().from(group).where(eq(group.id, groupId)).limit(1);
	if (!row) return null;
	if (isSuperadmin(actor)) return row;
	return row.ownerUserId === actor.id ? row : null;
}

export const load: PageServerLoad = async ({ locals }) => {
	// Groups exist so deployers and owners can grant access by name. A viewer-only account
	// manages nothing, so the page 404s for it the same way a site it cannot act on does.
	if (!(await hasOperatorAccess(locals.user!))) error(404, 'Not found');
	const actor = locals.user!;

	const groups = isSuperadmin(actor)
		? await db.select().from(group).orderBy(group.slug)
		: await db.select().from(group).where(eq(group.ownerUserId, actor.id)).orderBy(group.slug);

	const members = await db
		.select({
			groupId: groupMember.groupId,
			userId: groupMember.userId,
			email: user.email
		})
		.from(groupMember)
		.innerJoin(user, eq(user.id, groupMember.userId));

	// Only the accounts this actor administers can be put in a group — the same rule the
	// Users page runs on, because a membership is a grant with an extra step.
	const candidates = isSuperadmin(actor)
		? await db.select().from(user).orderBy(user.email)
		: await db
				.select()
				.from(user)
				.where(or(eq(user.createdByUserId, actor.id), eq(user.id, actor.id)))
				.orderBy(user.email);

	return {
		canManage: isAdmin(actor),
		users: candidates
			.filter((row) => manages(actor, row))
			.map((row) => ({ id: row.id, email: row.email })),
		groups: groups.map((row) => ({
			...row,
			members: members.filter((member) => member.groupId === row.id)
		}))
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const actor = requireAdmin(locals);
		const data = await request.formData();
		const slug = String(data.get('slug') ?? '')
			.trim()
			.toLowerCase();
		const name = String(data.get('name') ?? '').trim() || slug;

		if (!isValidSlug(slug))
			return fail(400, { message: 'Use lowercase letters, digits and dashes' });

		// The slug namespace is shared, so the clash can be with a group the actor cannot
		// see. Saying only that the name is taken is the right amount to say about it.
		const [existing] = await db.select({ id: group.id }).from(group).where(eq(group.slug, slug));
		if (existing) return fail(409, { message: `The group "${slug}" already exists` });

		const id = newId();
		await db.insert(group).values({ id, slug, name, ownerUserId: actor.id });
		await audit({
			action: 'group.created',
			actorUserId: actor.id,
			targetType: 'group',
			targetId: id,
			meta: { slug }
		});
		return { message: `Group ${slug} created` };
	},

	addMember: async ({ locals, request }) => {
		const actor = requireAdmin(locals);
		const data = await request.formData();
		const owned = await ownedGroup(actor, String(data.get('groupId') ?? ''));
		if (!owned) return fail(404, { message: 'That group is not yours to change' });

		const userId = String(data.get('userId') ?? '');
		// Empty when the combobox's typed text did not match a real person.
		if (!userId) return fail(400, { message: 'Pick someone to add' });

		// Checked server-side and not merely absent from the picker: the field is a plain
		// id in a form, and a group is a route into whatever it has been granted.
		const [target] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
		if (!target || !manages(actor, target)) {
			return fail(404, { message: 'That account is not yours to administer' });
		}

		await db.insert(groupMember).values({ groupId: owned.id, userId }).onConflictDoNothing();
		// Membership feeds the permission cache, which is what private sites read.
		await invalidateUserGroups(userId);
		await audit({
			action: 'group.member_added',
			actorUserId: actor.id,
			targetType: 'group',
			targetId: owned.id,
			meta: { userId }
		});
		return { message: 'Member added' };
	},

	removeMember: async ({ locals, request }) => {
		const actor = requireAdmin(locals);
		const data = await request.formData();
		const owned = await ownedGroup(actor, String(data.get('groupId') ?? ''));
		if (!owned) return fail(404, { message: 'That group is not yours to change' });

		// No `manages` check on the way out: taking someone's access away is never the
		// dangerous direction, and a membership left behind by a transfer has to be removable.
		const userId = String(data.get('userId') ?? '');
		await db
			.delete(groupMember)
			.where(and(eq(groupMember.groupId, owned.id), eq(groupMember.userId, userId)));
		await invalidateUserGroups(userId);
		await audit({
			action: 'group.member_removed',
			actorUserId: actor.id,
			targetType: 'group',
			targetId: owned.id,
			meta: { userId }
		});
		return { message: 'Member removed' };
	}
};
