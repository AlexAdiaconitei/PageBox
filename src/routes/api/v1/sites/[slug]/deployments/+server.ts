import type { RequestHandler } from './$types';
import { desc, eq } from 'drizzle-orm';
import { json, jsonError } from '$lib/server/api/auth';
import { clientIp, identifyCaller } from '$lib/server/api/context';
import { audit } from '$lib/server/audit';
import { config, siteUrl } from '$lib/server/config';
import { db } from '$lib/server/db';
import { deployment } from '$lib/server/db/schema';
import { ingestDeployment } from '$lib/server/deploy/ingest';
import { siteStorage } from '$lib/server/deploy/retention';
import { allowanceFor, ownerOf } from '$lib/server/quota';
import { verifyDeployment } from '$lib/server/deploy/verify';

const ACCEPTED_TYPES = [
	'application/zip',
	'application/x-zip-compressed',
	'application/octet-stream'
];

/** Upload a build: the body is the zip itself, no multipart wrapper. */
export const POST: RequestHandler = async (event) => {
	const identified = await identifyCaller(event, event.params.slug);
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
		// The quota refusal carries its arithmetic, so a CI log says "needs 4.2 GB, 1.1 GB
		// free of 100 GB" rather than a sentence somebody has to go and verify by hand.
		return jsonError(outcome.status, outcome.message, {
			reason: outcome.reason,
			...(outcome.quota ? { quota: outcome.quota } : {})
		});
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
			root: outcome.root || undefined,
			source: caller.kind === 'token' ? 'api' : 'panel-upload',
			warnings: warnings.length ? warnings : undefined,
			skipped: outcome.skipped.length,
			pruned: outcome.pruned.ids.length || undefined
		},
		ip: clientIp(event)
	});

	// Its own entry, not a field on the deploy: what a retention rule deleted has to be
	// findable by searching the trail for deletions, like every other deletion.
	if (outcome.pruned.ids.length > 0) {
		await audit({
			action: 'deployment.pruned',
			actorTokenId: caller.tokenId,
			actorUserId: caller.userId,
			targetType: 'site',
			targetId: siteRef.id,
			meta: {
				retentionLimit: siteRef.retentionLimit,
				deploymentIds: outcome.pruned.ids,
				reclaimedBytes: outcome.pruned.bytes,
				triggeredBy: outcome.deploymentId
			},
			ip: clientIp(event)
		});
	}

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
		// Says so out loud: an archive made with `zip -r site.zip out` is deployed as the
		// contents of out/, not as a folder called out.
		root: outcome.root,
		activated: activate,
		brokenAssets: verification?.brokenAssetCount ?? null,
		// Named, not just counted: "3 broken" sends you hunting, "/logo.svg is missing" does not.
		brokenAssetSamples: verification?.broken.slice(0, 5) ?? [],
		// Never a surprise: whoever uploaded is told what the retention rule removed to fit
		// this build in, in the same answer that says the build landed.
		retentionLimit: siteRef.retentionLimit,
		pruned: outcome.pruned.ids,
		prunedBytes: outcome.pruned.bytes,
		url: siteUrl(siteRef.basePath, event.url.port)
	});
};

/** Deployment history, newest first. */
export const GET: RequestHandler = async (event) => {
	const identified = await identifyCaller(event, event.params.slug);
	if ('response' in identified) return identified.response;
	const siteRef = identified.caller.siteRef;

	const limit = Math.min(Number(event.url.searchParams.get('limit') ?? 20) || 20, 100);
	const rows = await db
		.select()
		.from(deployment)
		.where(eq(deployment.siteId, siteRef.id))
		.orderBy(desc(deployment.createdAt))
		.limit(limit);

	const storage = (await siteStorage([siteRef.id])).get(siteRef.id);

	// What CI most wants before it builds: whether the next deploy will be allowed to land.
	const owner = await ownerOf(siteRef.id);
	const allowance = owner ? await allowanceFor(owner, siteRef) : { metered: false as const };

	return json(200, {
		slug: siteRef.slug,
		basePath: siteRef.basePath,
		siteUrl: siteUrl(siteRef.basePath, event.url.port),
		activeDeploymentId: siteRef.activeDeploymentId,
		// Serving state, not just deployment state: a site can hold a live build and still
		// answer 404 because an operator suspended it.
		serving: !siteRef.disabled,
		retentionLimit: siteRef.retentionLimit,
		storageBytes: storage?.bytes ?? 0,
		deploymentCount: storage?.deployments ?? 0,
		quota: allowance.metered
			? {
					owner: owner?.email,
					limit: allowance.quota,
					used: allowance.used,
					remaining: allowance.remaining,
					freedByRetention: allowance.freedByRetention,
					over: allowance.over
				}
			: null,
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
