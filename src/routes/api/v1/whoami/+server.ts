import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { authenticateToken, json, jsonError } from '$lib/server/api/auth';
import { tokenOwner } from '$lib/server/api/context';
import { config, siteUrl } from '$lib/server/config';
import { db } from '$lib/server/db';
import { site } from '$lib/server/db/schema';
import { atLeast, permissionFor } from '$lib/server/perms';

/**
 * Lets CI ask for its own base path before building, so the prefix is never hardcoded in
 * a workflow. When a site later moves to its own hostname (v2) the same call returns
 * basePath "/" and the next build comes out right without touching the pipeline.
 */
export const GET: RequestHandler = async (event) => {
	const authenticated = await authenticateToken(event);
	if ('error' in authenticated) {
		return jsonError(authenticated.error.status, authenticated.error.message);
	}

	const { auth } = authenticated;
	// Every key the panel issues names its site. One that does not was created by something
	// else and authorises nothing (see tokenAllowsSite) — so it has no identity to report.
	if (!auth.siteId) return jsonError(401, 'invalid token');

	const [row] = await db.select().from(site).where(eq(site.id, auth.siteId)).limit(1);
	if (!row || row.archivedAt) return jsonError(404, 'site not found');

	// This answer is site metadata — slug, base path, visibility — so it needs the same
	// permission the deploy endpoints do, checked against the owner as they stand now.
	const owner = await tokenOwner(auth);
	const permission = owner
		? await permissionFor(owner, {
				id: row.id,
				visibility: row.visibility,
				ownerUserId: row.ownerUserId
			})
		: null;
	if (!atLeast(permission, 'deployer')) return jsonError(404, 'site not found');

	return json(200, {
		scope: 'site',
		siteId: row.id,
		slug: row.slug,
		basePath: row.basePath,
		siteUrl: siteUrl(row.basePath, event.url.port),
		visibility: row.visibility,
		// A build is worth making either way, but a pipeline that deploys to a site nobody
		// is serving should be able to say so out loud.
		serving: row.disabledAt === null,
		mode: row.hostname ? 'subdomain' : 'path',
		maxUploadBytes: config.MAX_UPLOAD_BYTES
	});
};
