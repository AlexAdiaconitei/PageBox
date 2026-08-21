import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { json, jsonError } from '$lib/server/api/auth';
import { clientIp, identifyCaller } from '$lib/server/api/context';
import { audit } from '$lib/server/audit';
import { db } from '$lib/server/db';
import { deployment } from '$lib/server/db/schema';
import { deletePrefix, deploymentPrefix } from '$lib/server/s3';

export const GET: RequestHandler = async (event) => {
	const context = await identifyCaller(event, event.params.slug);
	if ('response' in context) return context.response;

	const row = await find(context.caller.siteRef.id, event.params.id);
	if (!row) return jsonError(404, 'deployment not found');

	return json(200, {
		id: row.id,
		status: row.status,
		active: row.id === context.caller.siteRef.activeDeploymentId,
		fileCount: row.fileCount,
		totalBytes: row.totalBytes,
		checksum: row.checksum,
		source: row.source,
		notes: row.notes,
		warnings: row.warnings,
		createdAt: row.createdAt,
		readyAt: row.readyAt
	});
};

/** Deleting the live deployment would take the site down, so it is refused. */
export const DELETE: RequestHandler = async (event) => {
	const context = await identifyCaller(event, event.params.slug);
	if ('response' in context) return context.response;
	const { caller } = context;
	const siteRef = caller.siteRef;

	const row = await find(siteRef.id, event.params.id);
	if (!row) return jsonError(404, 'deployment not found');
	if (row.id === siteRef.activeDeploymentId) {
		return jsonError(409, 'cannot delete the active deployment — activate another one first');
	}

	// Objects first, row second, and the row only if the objects actually went — the same
	// order the panel's action uses, for the same reason: the other way round leaves a
	// deployment the panel still lists and still offers to roll back to, which then serves
	// nothing. Failing loudly leaves it listed and intact, which is recoverable.
	try {
		await deletePrefix(deploymentPrefix(siteRef.id, row.id));
	} catch (err) {
		console.error(`[pagebox] could not drop the objects of deployment ${row.id}:`, err);
		return jsonError(502, 'storage refused to delete this deployment — nothing was removed');
	}
	await db.delete(deployment).where(eq(deployment.id, row.id));

	await audit({
		action: 'deployment.deleted',
		actorTokenId: caller.tokenId,
		actorUserId: caller.userId,
		targetType: 'deployment',
		targetId: row.id,
		meta: { siteId: siteRef.id, fileCount: row.fileCount },
		ip: clientIp(event)
	});

	return json(200, { deleted: row.id });
};

function find(siteId: string, id: string) {
	return db
		.select()
		.from(deployment)
		.where(and(eq(deployment.id, id), eq(deployment.siteId, siteId)))
		.limit(1)
		.then((rows) => rows[0] ?? null);
}
