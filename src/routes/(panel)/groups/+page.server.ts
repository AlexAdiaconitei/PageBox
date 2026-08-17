import { error, fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { audit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { group, groupMember, user } from '$lib/server/db/schema';
import { isValidSlug, newId } from '$lib/server/ids';
import { invalidateUserGroups } from '$lib/server/perms';

function requireSuperadmin(locals: App.Locals) {
	if (locals.user?.role !== 'superadmin') error(404, 'Not found');
	return locals.user;
}

export const load: PageServerLoad = async ({ locals }) => {
	// Everyone can see which groups exist — grants reference them by name — but only a
	// superadmin changes membership.
	const groups = await db.select().from(group).orderBy(group.slug);
	const members = await db
		.select({
			groupId: groupMember.groupId,
			userId: groupMember.userId,
			email: user.email
		})
		.from(groupMember)
		.innerJoin(user, eq(user.id, groupMember.userId));
	const users = await db.select({ id: user.id, email: user.email }).from(user).orderBy(user.email);

	return {
		canManage: locals.user!.role === 'superadmin',
		users,
		groups: groups.map((row) => ({
			...row,
			members: members.filter((member) => member.groupId === row.id)
		}))
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const actor = requireSuperadmin(locals);
		const data = await request.formData();
		const slug = String(data.get('slug') ?? '')
			.trim()
			.toLowerCase();
		const name = String(data.get('name') ?? '').trim() || slug;

		if (!isValidSlug(slug))
			return fail(400, { message: 'Use lowercase letters, digits and dashes' });

		const [existing] = await db.select({ id: group.id }).from(group).where(eq(group.slug, slug));
		if (existing) return fail(409, { message: `The group "${slug}" already exists` });

		const id = newId();
		await db.insert(group).values({ id, slug, name });
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
		const actor = requireSuperadmin(locals);
		const data = await request.formData();
		const groupId = String(data.get('groupId') ?? '');
		const userId = String(data.get('userId') ?? '');

		await db.insert(groupMember).values({ groupId, userId }).onConflictDoNothing();
		// Membership feeds the permission cache, which is what private sites read.
		await invalidateUserGroups(userId);
		await audit({
			action: 'group.member_added',
			actorUserId: actor.id,
			targetType: 'group',
			targetId: groupId,
			meta: { userId }
		});
		return { message: 'Member added' };
	},

	removeMember: async ({ locals, request }) => {
		const actor = requireSuperadmin(locals);
		const data = await request.formData();
		const groupId = String(data.get('groupId') ?? '');
		const userId = String(data.get('userId') ?? '');

		await db
			.delete(groupMember)
			.where(and(eq(groupMember.groupId, groupId), eq(groupMember.userId, userId)));
		await invalidateUserGroups(userId);
		await audit({
			action: 'group.member_removed',
			actorUserId: actor.id,
			targetType: 'group',
			targetId: groupId,
			meta: { userId }
		});
		return { message: 'Member removed' };
	}
};
