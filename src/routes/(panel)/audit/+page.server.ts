import { error } from '@sveltejs/kit';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { auditLog, user } from '$lib/server/db/schema';
import { hasOperatorAccess } from '$lib/server/perms';

export const load: PageServerLoad = async ({ locals, url }) => {
	// The trail spans every site, not just the ones a caller can act on — so it stays with
	// deployers, owners and superadmins, same as Groups.
	if (!(await hasOperatorAccess(locals.user!))) error(404, 'Not found');

	const action = url.searchParams.get('action') ?? '';
	const q = url.searchParams.get('q') ?? '';
	const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 300);

	const actionRows = await db
		.selectDistinct({ action: auditLog.action })
		.from(auditLog)
		.orderBy(auditLog.action);

	const conditions = [
		action ? eq(auditLog.action, action) : undefined,
		q
			? or(
					ilike(auditLog.action, `%${q}%`),
					ilike(user.email, `%${q}%`),
					ilike(auditLog.targetType, `%${q}%`),
					ilike(auditLog.targetId, `%${q}%`),
					ilike(auditLog.ip, `%${q}%`)
				)
			: undefined
	].filter(Boolean);

	const query = db
		.select({
			id: auditLog.id,
			action: auditLog.action,
			targetType: auditLog.targetType,
			targetId: auditLog.targetId,
			meta: auditLog.meta,
			ip: auditLog.ip,
			createdAt: auditLog.createdAt,
			actorEmail: user.email,
			actorTokenId: auditLog.actorTokenId
		})
		.from(auditLog)
		.leftJoin(user, eq(user.id, auditLog.actorUserId))
		.orderBy(desc(auditLog.createdAt))
		.limit(limit);

	const entries = conditions.length ? await query.where(and(...conditions)) : await query;

	return {
		entries,
		actions: actionRows.map((row) => row.action),
		action,
		q,
		viewer: locals.user!.email
	};
};
