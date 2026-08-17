import type { RequestEvent, RequestHandler } from './$types';
import { desc, eq } from 'drizzle-orm';
import { json, jsonError } from '$lib/server/api/auth';
import { clientIp, requireSiteToken } from '$lib/server/api/context';
import { audit } from '$lib/server/audit';
import { config, siteUrl } from '$lib/server/config';
import { db } from '$lib/server/db';
import { deployment } from '$lib/server/db/schema';
import { ingestDeployment } from '$lib/server/deploy/ingest';
import { verifyDeployment } from '$lib/server/deploy/verify';
import { atLeast, permissionFor } from '$lib/server/perms';
import { lookupSiteBySlug, type SiteRef } from '$lib/server/sites/resolve';

const ACCEPTED_TYPES = [
	'application/zip',
	'application/x-zip-compressed',
	'application/octet-stream'
];

type Caller = {
	kind: 'token' | 'session';
	tokenId: string | null;
	userId: string | null;
	siteRef: SiteRef;
};

/**
 * Two ways in, one endpoint.
 *
 * CI sends a bearer token; the panel's drag & drop sends the browser session. They differ
 * only in who is asking — the same guards, the same limits and the same ingestion run for
 * both, because two ingestion paths would be two sets of guards drifting apart.
 *
 * The cookie path is the one a browser can be tricked into making, so it is covered by the
 * same-origin check in hooks.server.ts; the bearer path is exempt there and needs no CSRF
 * token of its own.
 */
async function identify(
	event: RequestEvent,
	slug: string
): Promise<{ caller: Caller } | { response: Response }> {
	const hasBearer = event.request.headers.get('authorization')?.toLowerCase().startsWith('bearer ');

	if (hasBearer) {
		const context = await requireSiteToken(event, slug);
		if ('response' in context) return context;
		return {
			caller: {
				kind: 'token',
				tokenId: context.auth.tokenId,
				userId: context.auth.ownerUserId || null,
				siteRef: context.siteRef
			}
		};
	}

	const user = event.locals.user;
	if (!user) return { response: jsonError(401, 'sign in or send a deploy token') };

	const siteRef = await lookupSiteBySlug(slug);
	if (!siteRef || siteRef.archived) return { response: jsonError(404, 'site not found') };

	const permission = await permissionFor(user, siteRef);
	// Same answer as a site that does not exist: the API never confirms what is hosted
	// here to someone who may not deploy to it.
	if (!atLeast(permission, 'deployer')) return { response: jsonError(404, 'site not found') };

	return { caller: { kind: 'session', tokenId: null, userId: user.id, siteRef } };
}

/** Upload a build: the body is the zip itself, no multipart wrapper. */
export const POST: RequestHandler = async (event) => {
	const identified = await identify(event, event.params.slug);
	if ('response' in identified) return identified.response;
	const { caller } = identified;
	const siteRef = caller.siteRef;

	const contentType = (event.request.headers.get('content-type') ?? '').split(';')[0].trim();
	if (contentType && !ACCEPTED_TYPES.includes(contentType)) {
		return jsonError(415, `expected a zip body, got ${contentType}`);
	}

	// `?activate=false` uploads without switching the live pointer, for a two-step deploy.
	const activate = event.url.searchParams.get('activate') !== 'false';

	// The panel sends what its preflight warned about and whether the person accepted it.
	// PageBox deploys either way — it does not guess or rewrite HTML — but when the site
	// then does not work, the record of what was said and who accepted it is right here.
	const warnings = (event.url.searchParams.get('warnings') ?? '')
		.split(',')
		.map((code) => code.trim())
		.filter(Boolean);
	const acknowledged = event.url.searchParams.get('acknowledged') === '1';

	if (warnings.length > 0 && !acknowledged) {
		return jsonError(400, 'this upload reported warnings and was not acknowledged', { warnings });
	}

	const outcome = await ingestDeployment({
		body: event.request.body,
		siteRef,
		actor: { tokenId: caller.tokenId, userId: caller.userId },
		source: caller.kind === 'token' ? 'api' : 'panel-upload',
		notes: event.request.headers.get('x-deployment-notes'),
		activate,
		warnings,
		acknowledgedAt: warnings.length > 0 ? new Date() : null
	});

	if (!outcome.ok) {
		await audit({
			action: 'deployment.rejected',
			actorTokenId: caller.tokenId,
			actorUserId: caller.userId,
			targetType: 'site',
			targetId: siteRef.id,
			meta: { reason: outcome.reason ?? 'invalid', message: outcome.message },
			ip: clientIp(event)
		});
		return jsonError(outcome.status, outcome.message, { reason: outcome.reason });
	}

	await audit({
		action: outcome.reused ? 'deployment.reused' : 'deployment.created',
		actorTokenId: caller.tokenId,
		actorUserId: caller.userId,
		targetType: 'deployment',
		targetId: outcome.deploymentId,
		meta: {
			siteId: siteRef.id,
			fileCount: outcome.fileCount,
			totalBytes: outcome.totalBytes,
			activated: activate,
			source: caller.kind === 'token' ? 'api' : 'panel-upload',
			warnings: warnings.length ? warnings : undefined,
			skipped: outcome.skipped.length
		},
		ip: clientIp(event)
	});

	// Turns "we warned you about absolute paths" into "3 of its assets 404" — a fact
	// instead of a caveat. Only worth doing for a deployment that is actually live.
	const verification = activate
		? await verifyDeployment({ siteRef, deploymentId: outcome.deploymentId })
		: null;

	return json(201, {
		deploymentId: outcome.deploymentId,
		status: 'ready',
		fileCount: outcome.fileCount,
		totalBytes: outcome.totalBytes,
		reused: outcome.reused,
		skipped: outcome.skipped,
		activated: activate,
		brokenAssets: verification?.brokenAssetCount ?? null,
		url: siteUrl(siteRef.basePath)
	});
};

/** Deployment history, newest first. */
export const GET: RequestHandler = async (event) => {
	const identified = await identify(event, event.params.slug);
	if ('response' in identified) return identified.response;
	const siteRef = identified.caller.siteRef;

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
			warnings: row.warnings,
			brokenAssetCount: row.brokenAssetCount,
			createdAt: row.createdAt,
			readyAt: row.readyAt
		}))
	});
};
