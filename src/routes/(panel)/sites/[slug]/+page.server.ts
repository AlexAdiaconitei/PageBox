import { error, fail, redirect } from '@sveltejs/kit';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { audit } from '$lib/server/audit';
import { adminUrl, config, formatBytes, siteUrl } from '$lib/server/config';
import { db } from '$lib/server/db';
import {
	apikey,
	deployment,
	group,
	site,
	siteGrant,
	user,
	type SiteRole
} from '$lib/server/db/schema';
import { adminAuth } from '$lib/server/auth';
import { activate } from '$lib/server/deploy/ingest';
import {
	MAX_RETENTION,
	MIN_RETENTION,
	parseRetention,
	prunablePlan,
	pruneDeployments,
	siteStorage
} from '$lib/server/deploy/retention';
import { newId } from '$lib/server/ids';
import { atLeast, permissionFor } from '$lib/server/perms';
import { deletePrefix, deploymentPrefix, sitePrefix } from '$lib/server/s3';
import { invalidateSite, lookupSiteBySlug } from '$lib/server/sites/resolve';

/** Which site a deploy token is scoped to, as stored by the api-key plugin. */
function metadataSiteId(metadata: unknown): string | null {
	if (!metadata) return null;
	try {
		const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
		const siteId = (parsed as { siteId?: unknown }).siteId;
		return typeof siteId === 'string' ? siteId : null;
	} catch {
		return null;
	}
}

/** Loads the site and the caller's permission on it, or 404 if they may not see it. */
async function loadSite(slug: string, sessionUser: App.Locals['user']) {
	const siteRef = await lookupSiteBySlug(slug);
	if (!siteRef || siteRef.archived) error(404, 'Site not found');

	const permission = await permissionFor(sessionUser, siteRef);
	// A site you cannot act on does not exist as far as the panel is concerned. Public
	// sites give everyone `viewer`, which is not enough to open the panel page — a viewer
	// reads the live site itself (the Sites list links there instead), not its management
	// screen.
	if (!atLeast(permission, 'deployer')) error(404, 'Site not found');
	return { siteRef, permission: permission! };
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const { siteRef, permission } = await loadSite(params.slug, locals.user);

	const [row] = await db.select().from(site).where(eq(site.id, siteRef.id)).limit(1);
	const deployments = await db
		.select()
		.from(deployment)
		.where(eq(deployment.siteId, siteRef.id))
		.orderBy(desc(deployment.createdAt))
		.limit(25);

	const grants = await db
		.select()
		.from(siteGrant)
		.where(eq(siteGrant.siteId, siteRef.id))
		.orderBy(siteGrant.createdAt);

	// Deploy tokens are api keys; the one scoped to this site carries its id in metadata.
	const tokens = (
		await db.select().from(apikey).where(eq(apikey.enabled, true)).orderBy(desc(apikey.createdAt))
	).filter((row) => metadataSiteId(row.metadata) === siteRef.id);

	const users = await db
		.select({ id: user.id, email: user.email, name: user.name })
		.from(user)
		.orderBy(user.email);
	const groups = await db.select({ id: group.id, slug: group.slug, name: group.name }).from(group);

	const stored = (await siteStorage([siteRef.id])).get(siteRef.id);
	// `incoming: 1` — the build about to be uploaded takes a slot before it has a row.
	const nextPrune = await prunablePlan(siteRef.id, row.retentionLimit, row.activeDeploymentId, 1);

	const principalName = (type: string, id: string) =>
		type === 'user'
			? (users.find((entry) => entry.id === id)?.email ?? id)
			: (groups.find((entry) => entry.id === id)?.slug ?? id);

	return {
		adminOrigin: adminUrl('', url.port).replace(/\/$/, ''),
		site: {
			id: row.id,
			slug: row.slug,
			name: row.name,
			visibility: row.visibility,
			basePath: row.basePath,
			spaFallback: row.spaFallback,
			activeDeploymentId: row.activeDeploymentId,
			disabled: row.disabledAt !== null,
			disabledAt: row.disabledAt,
			disabledReason: row.disabledReason,
			retentionLimit: row.retentionLimit,
			url: siteUrl(row.basePath, url.port)
		},
		storage: {
			bytes: stored?.bytes ?? 0,
			deployments: stored?.deployments ?? 0,
			// What the *next* upload will delete, named before it happens rather than
			// reported after: the warning the retention limit owes whoever presses deploy.
			nextPrune: nextPrune.map((entry) => ({
				id: entry.id,
				totalBytes: entry.totalBytes,
				createdAt: entry.createdAt
			}))
		},
		retentionBounds: { min: MIN_RETENTION, max: MAX_RETENTION },
		permission,
		canManage: atLeast(permission, 'owner'),
		// Deleting releases a slug on a shared hostname, the same claim creating one makes,
		// so it sits with superadmins rather than with the site's owner.
		canDelete: locals.user!.role === 'superadmin',
		canDeploy: atLeast(permission, 'deployer'),
		limits: {
			maxFiles: config.MAX_FILES,
			// Below the server's own cap: packing a build in browser memory scales badly,
			// and past this the answer is a deploy token and CI, not a bigger browser.
			maxBrowserBytes: Math.min(config.MAX_UPLOAD_BYTES, 90 * 1024 * 1024)
		},
		deployments: deployments.map((entry) => ({
			id: entry.id,
			status: entry.status,
			fileCount: entry.fileCount,
			totalBytes: entry.totalBytes,
			source: entry.source,
			notes: entry.notes,
			createdAt: entry.createdAt,
			brokenAssetCount: entry.brokenAssetCount,
			live: entry.id === row.activeDeploymentId
		})),
		grants: grants.map((entry) => ({
			id: entry.id,
			principalType: entry.principalType,
			principalId: entry.principalId,
			principalName: principalName(entry.principalType, entry.principalId),
			role: entry.role
		})),
		tokens: tokens.map((entry) => ({
			id: entry.id,
			name: entry.name ?? 'deploy token',
			prefix: entry.start ?? entry.prefix ?? '',
			lastUsedAt: entry.lastRequest,
			expiresAt: entry.expiresAt,
			requestCount: entry.requestCount,
			createdAt: entry.createdAt
		})),
		users,
		groups
	};
};

export const actions: Actions = {
	activate: async ({ locals, params, request }) => {
		const { siteRef } = await loadSite(params.slug, locals.user);
		const data = await request.formData();
		const id = String(data.get('deploymentId') ?? '');

		const [row] = await db
			.select()
			.from(deployment)
			.where(and(eq(deployment.id, id), eq(deployment.siteId, siteRef.id)))
			.limit(1);
		if (!row) return fail(404, { message: 'That deployment is not on this site' });
		if (row.status !== 'ready') {
			return fail(409, { message: `A ${row.status} deployment cannot go live` });
		}

		await activate(siteRef, row.id);
		await audit({
			action: 'deployment.activated',
			actorUserId: locals.user!.id,
			targetType: 'deployment',
			targetId: row.id,
			meta: { siteId: siteRef.id, previousDeploymentId: siteRef.activeDeploymentId }
		});
		return { message: `Deployment ${row.id} is live` };
	},

	deleteDeployment: async ({ locals, params, request }) => {
		const { siteRef } = await loadSite(params.slug, locals.user);
		const data = await request.formData();
		const id = String(data.get('deploymentId') ?? '');

		if (id === siteRef.activeDeploymentId) {
			return fail(409, { message: 'Activate another deployment before deleting this one' });
		}

		// Objects first, row second, and the row only if the objects actually went. The other
		// order — or ignoring a failure here — leaves a deployment the panel still lists and
		// still offers to roll back to, which then serves nothing: a 404 with no explanation
		// anywhere. Failing loudly leaves it listed and intact instead, which is recoverable.
		try {
			await deletePrefix(deploymentPrefix(siteRef.id, id));
		} catch (err) {
			console.error(`[pagebox] could not drop the objects of deployment ${id}:`, err);
			return fail(502, {
				message: 'Storage refused to delete this deployment. Nothing was removed — try again.'
			});
		}

		await db
			.delete(deployment)
			.where(and(eq(deployment.id, id), eq(deployment.siteId, siteRef.id)));
		await audit({
			action: 'deployment.deleted',
			actorUserId: locals.user!.id,
			targetType: 'deployment',
			targetId: id,
			meta: { siteId: siteRef.id }
		});
		return { message: 'Deployment deleted' };
	},

	/**
	 * Removes the site and everything under it: every deployment, every object, every grant
	 * and every deploy token.
	 *
	 * The counterpart to disabling, and the reason disabling exists — a site that is merely
	 * in the way should be switched off, and only one that should never have existed gets
	 * this. Three guards, because it is the one action here nothing undoes: superadmin only,
	 * the slug has to be typed back, and the objects have to be gone before the row is.
	 *
	 * The slug is released by it. That is deliberate: a name held forever by something that
	 * no longer exists is how a slug nobody can explain ends up reserved.
	 */
	deleteSite: async ({ locals, params, request }) => {
		const { siteRef } = await loadSite(params.slug, locals.user);
		// Not `owner`: creating a site claims a slug on a shared hostname and stays with
		// superadmins, so releasing one does too.
		if (locals.user!.role !== 'superadmin') return fail(403, { message: 'Not allowed' });

		const data = await request.formData();
		if (String(data.get('confirm') ?? '').trim() !== siteRef.slug) {
			return fail(400, { message: `Type "${siteRef.slug}" to confirm` });
		}

		const stored = (await siteStorage([siteRef.id])).get(siteRef.id);

		try {
			await deletePrefix(sitePrefix(siteRef.id));
		} catch (err) {
			console.error(`[pagebox] could not drop the objects of site ${siteRef.slug}:`, err);
			return fail(502, {
				message: 'Storage refused to delete this site. Nothing was removed — try again.'
			});
		}

		// Deployments, grants and the deploy tokens scoped here go with it: `deployment` and
		// `site_grant` cascade on the FK, the keys carry their site in metadata and do not, so
		// they are deleted by hand — directly, for the same reason `revokeToken` does.
		const keys = (await db.select().from(apikey)).filter(
			(row) => metadataSiteId(row.metadata) === siteRef.id
		);
		if (keys.length > 0) {
			await db.delete(apikey).where(
				inArray(
					apikey.id,
					keys.map((key) => key.id)
				)
			);
		}

		await db.delete(site).where(eq(site.id, siteRef.id));
		await invalidateSite(siteRef.slug, siteRef.id);

		// Logged before the redirect and with everything worth keeping in it: the row that
		// named this site is gone, so the trail is the only record left that it was here.
		await audit({
			action: 'site.deleted',
			actorUserId: locals.user!.id,
			targetType: 'site',
			targetId: siteRef.id,
			meta: {
				slug: siteRef.slug,
				name: siteRef.name,
				deployments: stored?.deployments ?? 0,
				reclaimedBytes: stored?.bytes ?? 0,
				tokensRevoked: keys.length
			}
		});

		redirect(303, '/sites');
	},

	settings: async ({ locals, params, request }) => {
		const { siteRef, permission } = await loadSite(params.slug, locals.user);
		if (!atLeast(permission, 'owner')) return fail(403, { message: 'Not allowed' });

		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim() || siteRef.slug;
		const visibility = data.get('visibility') === 'public' ? 'public' : 'private';
		const spaFallback = data.get('spaFallback') === 'on';
		const retention = parseRetention(data.get('retentionLimit'));
		if (retention.error) return fail(400, { message: retention.error });

		await db
			.update(site)
			.set({ name, visibility, spaFallback, retentionLimit: retention.value })
			.where(eq(site.id, siteRef.id));
		await invalidateSite(siteRef.slug, siteRef.id);
		await audit({
			action: 'site.updated',
			actorUserId: locals.user!.id,
			targetType: 'site',
			targetId: siteRef.id,
			meta: { visibility, spaFallback, retentionLimit: retention.value }
		});

		// Lowering the limit does not wait for the next deploy: the person who just set it
		// is the one who should see what it costs, and they are still on the page.
		if (retention.value) {
			const outcome = await pruneDeployments(
				{ id: siteRef.id, activeDeploymentId: siteRef.activeDeploymentId },
				retention.value
			);
			if (outcome.prunedIds.length > 0) {
				await audit({
					action: 'deployment.pruned',
					actorUserId: locals.user!.id,
					targetType: 'site',
					targetId: siteRef.id,
					meta: {
						retentionLimit: retention.value,
						deploymentIds: outcome.prunedIds,
						reclaimedBytes: outcome.reclaimedBytes,
						triggeredBy: 'settings'
					}
				});
				return {
					message:
						`Settings saved — the new limit deleted ${outcome.prunedIds.length} old ` +
						`deployment(s), freeing ${formatBytes(outcome.reclaimedBytes)}`
				};
			}
		}
		return { message: 'Settings saved' };
	},

	/**
	 * Takes the site off the air, or puts it back. Deployments, grants and tokens are all
	 * untouched — this is a switch, not a delete, and flipping it back serves the same
	 * build that was serving before.
	 */
	serving: async ({ locals, params, request }) => {
		const { siteRef, permission } = await loadSite(params.slug, locals.user);
		if (!atLeast(permission, 'owner')) return fail(403, { message: 'Not allowed' });

		const data = await request.formData();
		const disable = data.get('disabled') === 'true';
		const reason = String(data.get('reason') ?? '').trim();

		await db
			.update(site)
			.set({
				disabledAt: disable ? new Date() : null,
				disabledReason: disable ? reason || null : null
			})
			.where(eq(site.id, siteRef.id));
		// Without this the cached SiteRef keeps serving for a full TTL after the switch.
		await invalidateSite(siteRef.slug, siteRef.id);

		await audit({
			action: disable ? 'site.disabled' : 'site.enabled',
			actorUserId: locals.user!.id,
			targetType: 'site',
			targetId: siteRef.id,
			meta: { reason: reason || undefined }
		});
		return {
			message: disable
				? 'Site disabled — it now answers 404 for everyone'
				: 'Site enabled — it is serving again'
		};
	},

	addGrant: async ({ locals, params, request }) => {
		const { siteRef, permission } = await loadSite(params.slug, locals.user);
		if (!atLeast(permission, 'owner')) return fail(403, { message: 'Not allowed' });

		const data = await request.formData();
		const [principalType, principalId] = String(data.get('principal') ?? '').split(':');
		const role = String(data.get('role') ?? 'viewer') as SiteRole;

		if (!principalId || (principalType !== 'user' && principalType !== 'group')) {
			return fail(400, { message: 'Pick someone to grant access to' });
		}

		await db
			.insert(siteGrant)
			.values({ id: newId(), siteId: siteRef.id, principalType, principalId, role })
			.onConflictDoUpdate({
				target: [siteGrant.siteId, siteGrant.principalType, siteGrant.principalId],
				set: { role }
			});

		await invalidateSite(siteRef.slug, siteRef.id);
		await audit({
			action: 'grant.set',
			actorUserId: locals.user!.id,
			targetType: 'site',
			targetId: siteRef.id,
			meta: { principalType, principalId, role }
		});
		return { message: 'Access granted' };
	},

	removeGrant: async ({ locals, params, request }) => {
		const { siteRef, permission } = await loadSite(params.slug, locals.user);
		if (!atLeast(permission, 'owner')) return fail(403, { message: 'Not allowed' });

		const data = await request.formData();
		const id = String(data.get('grantId') ?? '');
		await db.delete(siteGrant).where(and(eq(siteGrant.id, id), eq(siteGrant.siteId, siteRef.id)));

		await invalidateSite(siteRef.slug, siteRef.id);
		await audit({
			action: 'grant.removed',
			actorUserId: locals.user!.id,
			targetType: 'site',
			targetId: siteRef.id,
			meta: { grantId: id }
		});
		return { message: 'Access removed' };
	},

	createToken: async ({ locals, params, request }) => {
		const { siteRef, permission } = await loadSite(params.slug, locals.user);
		if (!atLeast(permission, 'owner')) return fail(403, { message: 'Not allowed' });

		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim() || 'deploy token';
		const days = Number(data.get('expiresInDays') ?? 0);

		const created = await adminAuth.api.createApiKey({
			body: {
				name,
				userId: locals.user!.id,
				// Scope: the token may only deploy to this site (see api/auth.ts).
				metadata: { siteId: siteRef.id, siteSlug: siteRef.slug },
				expiresIn: days > 0 ? days * 86_400 : null
			},
			headers: request.headers
		});

		await audit({
			action: 'token.created',
			actorUserId: locals.user!.id,
			targetType: 'site',
			targetId: siteRef.id,
			meta: { tokenId: created.id, name, expiresInDays: days || null }
		});

		// The only time the plaintext exists: the plugin stores a hash. A lost token is
		// reissued, never recovered.
		return { token: created.key, tokenName: name };
	},

	revokeToken: async ({ locals, params, request }) => {
		const { siteRef, permission } = await loadSite(params.slug, locals.user);
		if (!atLeast(permission, 'owner')) return fail(403, { message: 'Not allowed' });

		const data = await request.formData();
		const id = String(data.get('tokenId') ?? '');

		// Only keys belonging to this site may be revoked from this page.
		const [row] = await db.select().from(apikey).where(eq(apikey.id, id)).limit(1);
		if (!row || metadataSiteId(row.metadata) !== siteRef.id) {
			return fail(404, { message: 'That token is not on this site' });
		}

		// Deleted here rather than through `adminAuth.api.deleteApiKey`, which scopes deletion
		// to the *session's own* keys and answers KEY_NOT_FOUND for anybody else's — so an
		// owner pressing Revoke on a token a co-owner issued got a 500 and a live token. A
		// deploy token belongs to the site it was cut for, and the check above is what says
		// so; the site's owners revoke it, whoever pressed the button that made it.
		await db.delete(apikey).where(eq(apikey.id, id));

		await audit({
			action: 'token.revoked',
			actorUserId: locals.user!.id,
			targetType: 'site',
			targetId: siteRef.id,
			meta: { tokenId: id }
		});
		return { message: 'Token revoked' };
	}
};
