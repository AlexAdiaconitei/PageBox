import { desc, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { auditLog, user } from '$lib/server/db/schema';

export const load: PageServerLoad = async ({ locals, url }) => {
	const action = url.searchParams.get('action');
	const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 300);

	// Everyone sees the trail: it is the record of what happened to shared infrastructure,
	// and hiding it from the people it affects only slows down finding out why a site broke.
	const base = db
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

	const entries = action ? await base.where(eq(auditLog.action, action)) : await base;

	return { entries, action: action ?? '', viewer: locals.user!.email };
};
