import { and, eq, inArray, or } from 'drizzle-orm';
import { cache, cacheKeys, CACHE_TTL_SECONDS } from './cache';
import { db } from './db';
import { group, groupMember, site, siteGrant, type SiteRole } from './db/schema';
import { isAdmin, type SessionUser } from './auth';
import type { SiteRef } from './sites/resolve';

/**
 * Effective permission of a user on a site (docs/PLAN-static-hosting.md §4):
 *
 *   superadmin                        → owner
 *   site.owner_user_id == user.id     → owner
 *   max(role) over grants to the user or to any group they are in
 *   site.visibility == 'public'       → viewer, even anonymous
 *
 * viewer   = read the site
 * deployer = viewer + create deployments + activate/rollback
 * owner    = deployer + manage grants, tokens and visibility
 *
 * `admin` is deliberately absent from that list. It is a global role about running your own
 * patch, not a key to everyone else's: an admin reaches a site by having created it (which
 * sets `owner_user_id`) or by being granted it, exactly like anybody else. Were `admin` to
 * resolve to `owner` here the way `superadmin` does, the tier would be a second superadmin
 * with a quieter name and the whole boundary would be decorative.
 */

const RANK: Record<SiteRole, number> = { viewer: 1, deployer: 2, owner: 3 };

export type Permission = SiteRole | null;

export function atLeast(permission: Permission, required: SiteRole): boolean {
	return permission !== null && RANK[permission] >= RANK[required];
}

function highest(roles: SiteRole[]): Permission {
	return roles.reduce<Permission>(
		(best, role) => (best === null || RANK[role] > RANK[best] ? role : best),
		null
	);
}

/** Group ids the user belongs to. Cached: it is read on every private asset request. */
export async function groupsOf(userId: string): Promise<string[]> {
	const key = `groups:${userId}`;
	const cached = await cache.get<string[]>(key);
	if (cached) return cached;

	const rows = await db
		.select({ groupId: groupMember.groupId })
		.from(groupMember)
		.where(eq(groupMember.userId, userId));
	const ids = rows.map((row) => row.groupId);
	await cache.set(key, ids, CACHE_TTL_SECONDS);
	return ids;
}

export async function invalidateUserGroups(userId: string): Promise<void> {
	await cache.invalidatePrefix(`groups:${userId}`);
}

/** Effective permission, cached per (site, user) with the site's own invalidation key. */
export async function permissionFor(
	user: SessionUser | null,
	siteRef: Pick<SiteRef, 'id' | 'visibility' | 'ownerUserId'>
): Promise<Permission> {
	if (user?.role === 'superadmin') return 'owner';
	if (user && siteRef.ownerUserId === user.id) return 'owner';

	const key = cacheKeys.permission(siteRef.id, user?.id ?? null);
	const cached = await cache.get<Permission>(key);
	if (cached !== undefined) return cached;

	let permission: Permission = siteRef.visibility === 'public' ? 'viewer' : null;

	if (user) {
		const groupIds = await groupsOf(user.id);
		const principals = [
			and(eq(siteGrant.principalType, 'user'), eq(siteGrant.principalId, user.id)),
			groupIds.length
				? and(eq(siteGrant.principalType, 'group'), inArray(siteGrant.principalId, groupIds))
				: undefined
		].filter(Boolean);

		const grants = await db
			.select({ role: siteGrant.role })
			.from(siteGrant)
			.where(and(eq(siteGrant.siteId, siteRef.id), or(...principals)));

		const granted = highest(grants.map((row) => row.role));
		if (granted && (!permission || RANK[granted] > RANK[permission])) permission = granted;
	}

	await cache.set(key, permission, CACHE_TTL_SECONDS);
	return permission;
}

export type SiteSummary = {
	id: string;
	slug: string;
	name: string;
	visibility: 'public' | 'private';
	basePath: string;
	activeDeploymentId: string | null;
	/** Suspended: it holds everything it had and answers nothing (see sites/serve.ts). */
	disabled: boolean;
	retentionLimit: number | null;
	permission: SiteRole;
};

/**
 * Sites a user may see in the panel. A superadmin sees everything; everyone else sees
 * what they own or were granted — public sites are *not* included just for being public,
 * since the panel lists things you can act on, not things you can read.
 */
export async function sitesForUser(user: SessionUser): Promise<SiteSummary[]> {
	const rows = await db.select().from(site).orderBy(site.slug);
	const groupIds = await groupsOf(user.id);

	const grants =
		user.role === 'superadmin'
			? []
			: await db
					.select({ siteId: siteGrant.siteId, role: siteGrant.role })
					.from(siteGrant)
					.where(
						or(
							and(eq(siteGrant.principalType, 'user'), eq(siteGrant.principalId, user.id)),
							groupIds.length
								? and(
										eq(siteGrant.principalType, 'group'),
										inArray(siteGrant.principalId, groupIds)
									)
								: undefined
						)
					);

	const byGrant = new Map<string, SiteRole[]>();
	for (const grant of grants) {
		byGrant.set(grant.siteId, [...(byGrant.get(grant.siteId) ?? []), grant.role]);
	}

	const out: SiteSummary[] = [];
	for (const row of rows) {
		if (row.archivedAt) continue;
		let permission: Permission = null;
		if (user.role === 'superadmin' || row.ownerUserId === user.id) permission = 'owner';
		else permission = highest(byGrant.get(row.id) ?? []);
		if (!permission) continue;

		out.push({
			id: row.id,
			slug: row.slug,
			name: row.name,
			visibility: row.visibility,
			basePath: row.basePath,
			activeDeploymentId: row.activeDeploymentId,
			disabled: row.disabledAt !== null,
			retentionLimit: row.retentionLimit,
			permission
		});
	}
	return out;
}

/**
 * True for the superadmin and any admin, or for anyone who deploys or owns at least one
 * site. Groups and the audit trail are operator surfaces — a viewer-only account has no
 * grants to look up and no deploys to account for, so it gets neither the nav entry nor the
 * page (see the /groups and /audit `load` guards).
 *
 * An admin qualifies before owning anything: a freshly seated one has a group list and a
 * trail of its own to fill, and a surface that appears only once you have used it is a
 * surface nobody finds.
 */
export async function hasOperatorAccess(user: SessionUser): Promise<boolean> {
	if (isAdmin(user)) return true;
	const sites = await sitesForUser(user);
	return sites.some((entry) => atLeast(entry.permission, 'deployer'));
}

/** Group listing with member counts, for the panel. */
export async function allGroups() {
	const rows = await db.select().from(group).orderBy(group.slug);
	const members = await db.select().from(groupMember);
	return rows.map((row) => ({
		...row,
		memberCount: members.filter((member) => member.groupId === row.id).length
	}));
}

/**
 * Accounts `actor` may administer, and the single rule the admin tier rests on.
 *
 * - The superadmin administers everyone but itself. Its own seat is moved by handing it
 *   over, not by editing the row (see the users route).
 * - An admin administers the accounts it issued, and nothing else. Not its own row, not
 *   its peers, not the superadmin, not the accounts another admin created — a password
 *   reset on any of those is a way into somebody else's sites.
 * - Everyone else administers nobody.
 *
 * `target.createdByUserId` is null for accounts that predate the column and for anything
 * the superadmin made; both stay the superadmin's, which is the safe direction.
 */
export function manages(
	actor: Pick<SessionUser, 'id' | 'role'>,
	target: { id: string; role: string; createdByUserId: string | null }
): boolean {
	// The seat is never a target: not suspendable, not demotable, not resettable by anyone.
	if (target.role === 'superadmin') return false;
	if (target.id === actor.id) return false;
	if (actor.role === 'superadmin') return true;
	return actor.role === 'admin' && target.createdByUserId === actor.id;
}
