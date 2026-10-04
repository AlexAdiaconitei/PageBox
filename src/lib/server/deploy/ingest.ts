import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq } from 'drizzle-orm';
import { formatBytes, getConfig } from '../config';
import { db } from '../db';
import { withStorageLock } from '../db/locks';
import { deployment, site } from '../db/schema';
import { newId } from '../ids';
import { deletePrefix, deploymentPrefix, headObject, objectKey } from '../s3';
import { allowanceFor, instanceUsage, ownerOf, quotaFor, usageFor } from '../quota';
import { invalidateSite, lookupSiteBySlug, type SiteRef } from '../sites/resolve';
import { prunablePlan, pruneDeployments } from './retention';
import { extractZipToS3, INGEST_VERSION, measureZip, ZipRejected } from './zip';

/**
 * Turns an uploaded archive into an activated deployment.
 *
 * The active pointer moves only after every object is in S3, so a failed upload leaves
 * the previous deployment serving. Nothing is ever extracted to disk: the archive lands
 * in a temp file (random access is required to read a zip), and each entry goes from the
 * archive straight to S3.
 */

export type IngestOutcome =
	| {
			ok: true;
			deploymentId: string;
			fileCount: number;
			totalBytes: number;
			/** True when an identical archive was already deployed and got reused. */
			reused: boolean;
			skipped: string[];
			/** Directory the archive was rebased onto, '' when it was already at the root. */
			root: string;
			/** Older deployments the site's retention limit dropped to make room for this one. */
			pruned: { ids: string[]; bytes: number };
	  }
	| {
			ok: false;
			status: 400 | 413;
			message: string;
			reason?: string;
			/** Set on a quota refusal, so the caller can print figures instead of a sentence. */
			quota?: { used: number; quota: number; needed: number; freedByRetention: number };
	  };

export type IngestInput = {
	body: ReadableStream<Uint8Array> | null;
	siteRef: SiteRef;
	actor: { tokenId?: string | null; userId?: string | null };
	source: 'api' | 'panel-upload';
	notes?: string | null;
	activate: boolean;
	authorize: () => Promise<boolean>;
	/** Preflight warnings the uploader was shown and accepted (§6.3). */
	warnings?: string[];
	acknowledgedAt?: Date | null;
};

export async function ingestDeployment(input: IngestInput): Promise<IngestOutcome> {
	const config = getConfig();
	if (!input.body) return { ok: false, status: 400, message: 'empty request body' };

	const dir = await mkdtemp(join(process.env.PAGEBOX_TMP_DIR ?? tmpdir(), 'pagebox-'));
	const archivePath = join(dir, 'upload.zip');
	let deploymentId: string | null = null;

	try {
		const written = await writeArchive(input.body, archivePath, config.MAX_UPLOAD_BYTES);
		if (!written.ok) return written.error;

		// An identical archive means the CI job is retrying: reuse what is already in S3
		// instead of writing a second copy of the same bytes.
		const measured = await measureZip(archivePath);
		return await withStorageLock(async () => {
			try {
				const current = await lookupSiteBySlug(input.siteRef.slug);
				if (!current || current.id !== input.siteRef.id) error(404, 'Site not found');
				const [siteRow] = await db.select().from(site).where(eq(site.id, current.id)).limit(1);
				if (siteRow.deletingAt) error(409, 'Site deletion is in progress');
				input.siteRef = current;
				if (!(await input.authorize())) error(403, 'Deployment permission was revoked');
				const existing = await findReusable(input.siteRef.id, written.checksum);
				if (existing) {
					if (input.activate) await activate(input.siteRef, existing.id);
					// Nothing new was stored, so nothing has to make room — but the deployment that
					// just became live may have been the one retention was about to drop, and after
					// the activation it is not. Re-running the rule keeps the two consistent.
					const pruned = await applyRetention(input.siteRef, existing.id, input.activate);
					return {
						ok: true,
						deploymentId: existing.id,
						fileCount: existing.fileCount,
						totalBytes: existing.totalBytes,
						reused: true,
						skipped: [],
						root: '',
						pruned
					};
				}

				// What this archive would store, measured off its own central directory before a byte
				// of it is written. The alternative is to find out mid-extraction, having already put
				// most of a build in the bucket to then delete it — and for the panel uploader, to
				// have somebody watch a progress bar for a deploy that was never going to land.
				return await store(measured.totalBytes, written.checksum);
			} catch (err) {
				if (deploymentId) {
					await markFailed(input.siteRef.id, deploymentId);
					deploymentId = null;
				}
				throw err;
			}
		});
	} catch (err) {
		if (deploymentId) await markFailed(input.siteRef.id, deploymentId);
		if (err instanceof ZipRejected) {
			return {
				ok: false,
				status: err.reason === 'quota' ? 413 : 400,
				message: err.message,
				reason: err.reason
			};
		}
		throw err;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}

	/**
	 * The part that must not race: measure against the owner's allowance, then store.
	 * Declared here so it closes over the archive path and the ids the caller set up.
	 */
	async function store(measuredBytes: number, checksum: string): Promise<IngestOutcome> {
		const budget = await quotaBudget(input.siteRef, measuredBytes);
		if (budget.refusal) return budget.refusal;

		deploymentId = newId();
		await db.insert(deployment).values({
			id: deploymentId,
			siteId: input.siteRef.id,
			status: 'uploading',
			checksum,
			ingestVersion: INGEST_VERSION,
			source: input.source,
			totalBytes: measuredBytes,
			notes: input.notes ?? null,
			warnings: input.warnings?.length ? input.warnings : null,
			acknowledgedAt: input.acknowledgedAt ?? null,
			createdByUserId: input.actor.userId ?? null,
			createdByTokenId: input.actor.tokenId ?? null
		});

		const result = await extractZipToS3(
			archivePath,
			{ siteId: input.siteRef.id, deploymentId },
			{
				maxFiles: config.MAX_FILES,
				maxUncompressedBytes: config.MAX_UNCOMPRESSED_BYTES,
				maxRatio: config.MAX_ZIP_RATIO,
				// The backstop: the pre-check above trusts what the archive says about itself,
				// and this does not.
				remainingQuota: budget.remaining
			}
		);

		if (!(await input.authorize())) error(403, 'Deployment permission was revoked');
		await db
			.update(deployment)
			.set({
				status: 'ready',
				fileCount: result.fileCount,
				totalBytes: result.totalBytes,
				readyAt: new Date()
			})
			.where(eq(deployment.id, deploymentId));

		// Keep the old active build protected until retention has actually freed the credited bytes.
		const beforeActivation = await applyRetention(input.siteRef, deploymentId, false);
		const owner = await ownerOf(input.siteRef.id);
		const quota = owner ? await quotaFor(owner) : null;
		if (owner && quota !== null && (await usageFor(owner.id)) > quota) {
			throw new ZipRejected(
				'Storage did not free enough retained bytes; the previous deployment remains active',
				'quota'
			);
		}
		if (config.PAGEBOX_STORAGE_BYTES && (await instanceUsage()) > config.PAGEBOX_STORAGE_BYTES) {
			throw new ZipRejected(
				'The instance storage budget is exhausted; the previous deployment remains active',
				'quota'
			);
		}
		if (input.activate) await activate(input.siteRef, deploymentId);
		const afterActivation = input.activate
			? await applyRetention(input.siteRef, deploymentId, true)
			: { ids: [], bytes: 0 };
		const pruned = {
			ids: [...beforeActivation.ids, ...afterActivation.ids],
			bytes: beforeActivation.bytes + afterActivation.bytes
		};

		return {
			ok: true,
			deploymentId,
			fileCount: result.fileCount,
			totalBytes: result.totalBytes,
			reused: false,
			skipped: result.skipped,
			root: result.root,
			pruned
		};
	}
}

/**
 * How many bytes this upload may store, and the refusal when it already cannot.
 *
 * Charged to whoever owns the site, not to whoever pressed deploy: a deployer granted
 * access to somebody else's site is spending that owner's allowance, because it is their
 * bucket space the build will sit in. A site with no owner is unmetered — its bytes belong
 * to no allocation, which the panel reports rather than silently charging to the seat.
 */
async function quotaBudget(
	siteRef: SiteRef,
	bytes: number
): Promise<{ refusal: Extract<IngestOutcome, { ok: false }> | null; remaining: number | null }> {
	const owner = await ownerOf(siteRef.id);
	const total = getConfig().PAGEBOX_STORAGE_BYTES;
	if (total) {
		const used = await instanceUsage();
		const doomed = await prunablePlan(
			siteRef.id,
			siteRef.retentionLimit,
			siteRef.activeDeploymentId,
			1
		);
		const freed = doomed.reduce((sum, row) => sum + row.totalBytes, 0);
		const remaining = Math.max(0, total - used + freed);
		if (bytes > remaining) {
			return {
				remaining,
				refusal: {
					ok: false,
					status: 413,
					reason: 'quota',
					message: 'The instance storage budget cannot fit this deployment',
					quota: { used, quota: total, needed: bytes, freedByRetention: freed }
				}
			};
		}
	}
	if (!owner) return { refusal: null, remaining: null };

	const allowance = await allowanceFor(owner, siteRef);
	if (!allowance.metered) return { refusal: null, remaining: null };
	if (bytes <= allowance.remaining) return { refusal: null, remaining: allowance.remaining };

	return {
		remaining: allowance.remaining,
		refusal: {
			ok: false,
			status: 413,
			reason: 'quota',
			message:
				`this build needs ${formatBytes(bytes)} and only ` +
				`${formatBytes(allowance.remaining)} of the ${formatBytes(allowance.quota)} quota is free`,
			quota: {
				used: allowance.used,
				quota: allowance.quota,
				needed: bytes,
				freedByRetention: allowance.freedByRetention
			}
		}
	};
}

/**
 * Enforces the site's retention limit after a successful upload.
 *
 * Never throws: a bucket that will not delete is a housekeeping problem, and turning it
 * into a failed deploy would mean a site cannot be updated because its old builds are
 * stuck. The failure is loud in the log and the row stays listed in the panel.
 */
async function applyRetention(
	siteRef: SiteRef,
	justDeployedId: string,
	activated: boolean
): Promise<{ ids: string[]; bytes: number }> {
	if (!siteRef.retentionLimit) return { ids: [], bytes: 0 };
	try {
		// `siteRef` is a snapshot taken before this upload; the live pointer moved a moment
		// ago, and pruning must protect what is live *now*.
		const activeDeploymentId = activated ? justDeployedId : siteRef.activeDeploymentId;
		const outcome = await pruneDeployments(
			{ id: siteRef.id, activeDeploymentId },
			siteRef.retentionLimit
		);
		return { ids: outcome.prunedIds, bytes: outcome.reclaimedBytes };
	} catch (err) {
		console.error(`[pagebox] retention: could not prune ${siteRef.slug}:`, err);
		return { ids: [], bytes: 0 };
	}
}

export async function activate(siteRef: SiteRef, deploymentId: string): Promise<void> {
	return withStorageLock(async () => {
		const [current] = await db.select().from(site).where(eq(site.id, siteRef.id)).limit(1);
		const [target] = await db
			.select()
			.from(deployment)
			.where(and(eq(deployment.id, deploymentId), eq(deployment.siteId, siteRef.id)))
			.limit(1);
		if (!current || !target) error(404, 'Deployment not found');
		if (current.deletingAt || target.status !== 'ready')
			error(409, 'Only a ready deployment on a live site can be activated');
		await db.update(site).set({ activeDeploymentId: deploymentId }).where(eq(site.id, siteRef.id));
		await invalidateSite(siteRef.slug, siteRef.id);
	});
}

/** Drops the objects and marks the row, so a dead upload leaves nothing behind. */
async function markFailed(siteId: string, deploymentId: string): Promise<void> {
	await withStorageLock(async () => {
		await db
			.update(deployment)
			.set({ status: 'cleanup_pending' })
			.where(eq(deployment.id, deploymentId));
		try {
			await deletePrefix(deploymentPrefix(siteId, deploymentId));
			await db
				.update(deployment)
				.set({ status: 'failed', totalBytes: 0 })
				.where(eq(deployment.id, deploymentId));
		} catch (err) {
			console.error('[pagebox] failed upload cleanup queued for retry:', err);
		}
	});
}

/**
 * A previous deployment of exactly these bytes, worth activating instead of storing a
 * second copy — but only when it is still the same thing as what we would produce now.
 *
 * Two conditions beyond the checksum, both learned the hard way: it must come from the
 * current extraction rules, and its objects must still be there. Reusing across a rule
 * change resurrects a deployment built by the old ones, which is how a fixed upload
 * silently re-served a broken site.
 */
async function findReusable(siteId: string, checksum: string) {
	const [row] = await db
		.select()
		.from(deployment)
		.where(
			and(
				eq(deployment.siteId, siteId),
				eq(deployment.checksum, checksum),
				eq(deployment.status, 'ready'),
				eq(deployment.ingestVersion, INGEST_VERSION)
			)
		)
		.limit(1);

	if (!row) return null;

	const intact = await headObject(objectKey(siteId, row.id, 'index.html'));
	return intact ? row : null;
}

type WriteResult =
	| { ok: true; checksum: string; bytes: number }
	| { ok: false; error: Extract<IngestOutcome, { ok: false }> };

/**
 * Streams the body to disk, hashing as it goes and aborting the moment the cap is
 * crossed. adapter-node enforces the same cap at the HTTP layer (BODY_SIZE_LIMIT), but a
 * limit that only exists in the proxy is a limit that disappears the day the proxy changes.
 */
async function writeArchive(
	body: ReadableStream<Uint8Array>,
	path: string,
	maxBytes: number
): Promise<WriteResult> {
	const hash = createHash('sha256');
	let bytes = 0;
	let overflowed = false;

	try {
		await pipeline(
			Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
			async function* (source) {
				for await (const chunk of source) {
					const buffer = chunk as Buffer;
					bytes += buffer.length;
					if (bytes > maxBytes) {
						overflowed = true;
						throw new Error('upload cap exceeded');
					}
					hash.update(buffer);
					yield buffer;
				}
			},
			createWriteStream(path)
		);
	} catch (err) {
		if (overflowed) {
			return {
				ok: false,
				error: {
					ok: false,
					status: 413,
					message: `upload exceeds MAX_UPLOAD_BYTES (${maxBytes} bytes)`
				}
			};
		}
		throw err;
	}

	if (bytes === 0) {
		return { ok: false, error: { ok: false, status: 400, message: 'empty request body' } };
	}
	return { ok: true, checksum: hash.digest('hex'), bytes };
}
