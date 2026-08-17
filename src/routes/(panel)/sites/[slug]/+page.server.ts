import { error, fail } from '@sveltejs/kit';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { audit } from '$lib/server/audit';
import { adminUrl, config, siteUrl } from '$lib/server/config';
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
import { newId } from '$lib/server/ids';
import { atLeast, permissionFor } from '$lib/server/perms';
import { deletePrefix, deploymentPrefix } from '$lib/server/s3';
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
	// sites give everyone `viewer`, which is not enough to open the panel page.
	if (!atLeast(permission, 'deployer')) error(404, 'Site not found');
	return { siteRef, permission: permission! };
}

export const load: PageServerLoad = async ({ locals, params }) => {
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

	const principalName = (type: string, id: string) =>
		type === 'user'
			? (users.find((entry) => entry.id === id)?.email ?? id)
			: (groups.find((entry) => entry.id === id)?.slug ?? id);

	return {
		adminOrigin: adminUrl('').replace(/\/$/, ''),
		site: {
			id: row.id,
			slug: row.slug,
			name: row.name,
			visibility: row.visibility,
			basePath: row.basePath,
			spaFallback: row.spaFallback,
			activeDeploymentId: row.activeDeploymentId,
			url: siteUrl(row.basePath)
		},
		permission,
		canManage: atLeast(permission, 'owner'),
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

		await deletePrefix(deploymentPrefix(siteRef.id, id));
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

	settings: async ({ locals, params, request }) => {
		const { siteRef, permission } = await loadSite(params.slug, locals.user);
		if (!atLeast(permission, 'owner')) return fail(403, { message: 'Not allowed' });

		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim() || siteRef.slug;
		const visibility = data.get('visibility') === 'public' ? 'public' : 'private';
		const spaFallback = data.get('spaFallback') === 'on';

		await db.update(site).set({ name, visibility, spaFallback }).where(eq(site.id, siteRef.id));
		await invalidateSite(siteRef.slug, siteRef.id);
		await audit({
			action: 'site.updated',
			actorUserId: locals.user!.id,
			targetType: 'site',
			targetId: siteRef.id,
			meta: { visibility, spaFallback }
		});
		return { message: 'Settings saved' };
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
		await adminAuth.api.deleteApiKey({ body: { keyId: id }, headers: request.headers });

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
