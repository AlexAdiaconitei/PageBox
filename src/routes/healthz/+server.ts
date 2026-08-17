import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { probeHealth } from '$lib/server/health';

/**
 * Health endpoint for a request that arrived on one of the configured hostnames. Probes
 * from an orchestrator usually arrive by IP instead and are answered in hooks.server.ts
 * with a reduced body.
 */
export const GET: RequestHandler = async () => {
	const health = await probeHealth();
	return new Response(
		JSON.stringify({
			status: health.ok ? 'ok' : 'degraded',
			db: health.db,
			s3: health.s3,
			adminHost: config.PAGEBOX_ADMIN_HOST,
			sitesHost: config.PAGEBOX_SITES_HOST,
			uploadCap: config.maxUploadLabel
		}),
		{
			status: health.ok ? 200 : 503,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		}
	);
};
