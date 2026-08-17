import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { authenticateToken, json, jsonError } from '$lib/server/api/auth';
import { config, siteUrl } from '$lib/server/config';
import { db } from '$lib/server/db';
import { site } from '$lib/server/db/schema';

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
	if (!auth.siteId) {
		// A token valid for every site cannot answer "which site am I?".
		return json(200, { scope: 'all', mode: 'path', sitesHost: config.PAGEBOX_SITES_HOST });
	}

	const [row] = await db.select().from(site).where(eq(site.id, auth.siteId)).limit(1);
	if (!row) return jsonError(404, 'site not found');

	return json(200, {
		scope: 'site',
		siteId: row.id,
		slug: row.slug,
		basePath: row.basePath,
		siteUrl: siteUrl(row.basePath, event.url.port),
		visibility: row.visibility,
		mode: row.hostname ? 'subdomain' : 'path',
		maxUploadBytes: config.MAX_UPLOAD_BYTES
	});
};
