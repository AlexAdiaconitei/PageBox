import { error } from '@sveltejs/kit';
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { isSuperadmin, type SessionUser } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { auditLog, deployment, user } from '$lib/server/db/schema';
import { hasOperatorAccess, sitesForUser } from '$lib/server/perms';

/**
 * Which entries this actor is allowed to read, or null for "all of them".
 *
 * The trail spans the whole instance, which under one superadmin was the same thing as
 * "everything you run". It is not, once there are admins: an unfiltered trail hands one
 * admin the deploy history, token names and sign-in attempts of every other. So an admin
 * reads two things — what they and the accounts they issued did, and what was done to the
 * sites they can act on — and the superadmin reads all of it.
 */
async function visibleTo(actor: SessionUser) {
	if (isSuperadmin(actor)) return null;

	const issued = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.createdByUserId, actor.id));
	const actorIds = [actor.id, ...issued.map((row) => row.id)];

	// Sites they can act on, plus the deployments underneath them — a deploy is recorded
	// against the deployment, not the site, so the site clause alone would drop exactly the
	// rows an operator opens this page for.
	//
	// The deployment half is a subquery rather than a list of ids: materialising every
	// deployment an admin owns into an `IN (…)` grows the query text with their history,
	// and a busy site has thousands.
	const sites = await sitesForUser(actor);
	const siteIds = sites.map((entry) => entry.id);

	return or(
		inArray(auditLog.actorUserId, actorIds),
		siteIds.length
			? and(eq(auditLog.targetType, 'site'), inArray(auditLog.targetId, siteIds))
			: undefined,
		siteIds.length
			? and(
					eq(auditLog.targetType, 'deployment'),
					inArray(
						auditLog.targetId,
						db
							.select({ id: deployment.id })
							.from(deployment)
							.where(inArray(deployment.siteId, siteIds))
					)
				)
			: undefined
	);
}

export const load: PageServerLoad = async ({ locals, url }) => {
	// The trail spans every site, not just the ones a caller can act on — so it stays with
	// deployers, owners and superadmins, same as Groups.
	if (!(await hasOperatorAccess(locals.user!))) error(404, 'Not found');

	const scope = await visibleTo(locals.user!);
	const action = url.searchParams.get('action') ?? '';
	const q = url.searchParams.get('q') ?? '';
	const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 300);

	// The filter list is built from the rows this actor can see, so it never names an
	// action that only happens on somebody else's patch.
	const actionQuery = db.selectDistinct({ action: auditLog.action }).from(auditLog);
	const actionRows = await (scope ? actionQuery.where(scope) : actionQuery).orderBy(
		auditLog.action
	);

	const conditions = [
		// `undefined`, not `null`: drizzle drops undefined operands from an `and()` and
		// chokes on a null one, and "no scope" means "add no clause".
		scope ?? undefined,
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
		viewer: locals.user!.email,
		// Says which trail this is, because "Every deploy…" is a lie on a filtered one.
		wholeInstance: scope === null
	};
};
