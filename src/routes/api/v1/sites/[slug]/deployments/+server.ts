import type { RequestHandler } from './$types';
import { desc, eq } from 'drizzle-orm';
import { json, jsonError } from '$lib/server/api/auth';
import { clientIp, requireSiteToken } from '$lib/server/api/context';
import { audit } from '$lib/server/audit';
import { config, siteUrl } from '$lib/server/config';
import { db } from '$lib/server/db';
import { deployment } from '$lib/server/db/schema';
import { ingestDeployment } from '$lib/server/deploy/ingest';

const ACCEPTED_TYPES = [
	'application/zip',
	'application/x-zip-compressed',
	'application/octet-stream'
];

/** Upload a build: the body is the zip itself, no multipart wrapper. */
export const POST: RequestHandler = async (event) => {
	const context = await requireSiteToken(event, event.params.slug);
	if ('response' in context) return context.response;
	const { auth, siteRef } = context;

	const contentType = (event.request.headers.get('content-type') ?? '').split(';')[0].trim();
	if (contentType && !ACCEPTED_TYPES.includes(contentType)) {
		return jsonError(415, `expected a zip body, got ${contentType}`);
	}

	// `?activate=false` uploads without switching the live pointer, for a two-step deploy.
	const activate = event.url.searchParams.get('activate') !== 'false';

	const outcome = await ingestDeployment({
		body: event.request.body,
		siteRef,
		actor: { tokenId: auth.tokenId, userId: auth.createdByUserId },
		source: 'api',
		notes: event.request.headers.get('x-deployment-notes'),
		activate
	});

	if (!outcome.ok) {
		await audit({
			action: 'deployment.rejected',
			actorTokenId: auth.tokenId,
			targetType: 'site',
			targetId: siteRef.id,
			meta: { reason: outcome.reason ?? 'invalid', message: outcome.message },
			ip: clientIp(event)
		});
		return jsonError(outcome.status, outcome.message, { reason: outcome.reason });
	}

	await audit({
		action: outcome.reused ? 'deployment.reused' : 'deployment.created',
		actorTokenId: auth.tokenId,
		targetType: 'deployment',
		targetId: outcome.deploymentId,
		meta: {
			siteId: siteRef.id,
			fileCount: outcome.fileCount,
			totalBytes: outcome.totalBytes,
			activated: activate,
			skipped: outcome.skipped.length
		},
		ip: clientIp(event)
	});

	return json(201, {
		deploymentId: outcome.deploymentId,
		status: 'ready',
		fileCount: outcome.fileCount,
		totalBytes: outcome.totalBytes,
		reused: outcome.reused,
		skipped: outcome.skipped,
		activated: activate,
		url: siteUrl(siteRef.basePath)
	});
};

/** Deployment history, newest first. */
export const GET: RequestHandler = async (event) => {
	const context = await requireSiteToken(event, event.params.slug);
	if ('response' in context) return context.response;
	const { siteRef } = context;

	const limit = Math.min(Number(event.url.searchParams.get('limit') ?? 20) || 20, 100);
	const rows = await db
		.select()
		.from(deployment)
		.where(eq(deployment.siteId, siteRef.id))
		.orderBy(desc(deployment.createdAt))
		.limit(limit);

	return json(200, {
		slug: siteRef.slug,
		basePath: siteRef.basePath,
		siteUrl: siteUrl(siteRef.basePath),
		activeDeploymentId: siteRef.activeDeploymentId,
		maxUploadBytes: config.MAX_UPLOAD_BYTES,
		deployments: rows.map((row) => ({
			id: row.id,
			status: row.status,
			active: row.id === siteRef.activeDeploymentId,
			fileCount: row.fileCount,
			totalBytes: row.totalBytes,
			source: row.source,
			notes: row.notes,
			createdAt: row.createdAt,
			readyAt: row.readyAt
		}))
	});
};
