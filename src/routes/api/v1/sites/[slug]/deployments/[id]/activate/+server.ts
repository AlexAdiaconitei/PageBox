import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { json, jsonError } from '$lib/server/api/auth';
import { clientIp, identifyCaller } from '$lib/server/api/context';
import { audit } from '$lib/server/audit';
import { siteUrl } from '$lib/server/config';
import { db } from '$lib/server/db';
import { deployment } from '$lib/server/db/schema';
import { activate } from '$lib/server/deploy/ingest';

/** Rollback and roll-forward are the same operation: point the site at a deployment. */
export const POST: RequestHandler = async (event) => {
	const context = await identifyCaller(event, event.params.slug);
	if ('response' in context) return context.response;
	const { caller } = context;
	const siteRef = caller.siteRef;

	const [row] = await db
		.select()
		.from(deployment)
		.where(and(eq(deployment.id, event.params.id), eq(deployment.siteId, siteRef.id)))
		.limit(1);

	if (!row) return jsonError(404, 'deployment not found');
	if (row.status !== 'ready') {
		return jsonError(409, `deployment is ${row.status}, only a ready one can be activated`);
	}

	const previous = siteRef.activeDeploymentId;
	await activate(siteRef, row.id);

	await audit({
		action: 'deployment.activated',
		actorTokenId: caller.tokenId,
		actorUserId: caller.userId,
		targetType: 'deployment',
		targetId: row.id,
		meta: { siteId: siteRef.id, previousDeploymentId: previous },
		ip: clientIp(event)
	});

	return json(200, {
		deploymentId: row.id,
		previousDeploymentId: previous,
		url: siteUrl(siteRef.basePath)
	});
};
