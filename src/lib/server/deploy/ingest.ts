import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, eq } from 'drizzle-orm';
import { getConfig } from '../config';
import { db } from '../db';
import { deployment, site } from '../db/schema';
import { newId } from '../ids';
import { deletePrefix, deploymentPrefix, headObject, objectKey } from '../s3';
import { invalidateSite, type SiteRef } from '../sites/resolve';
import { extractZipToS3, INGEST_VERSION, ZipRejected } from './zip';

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
	  }
	| { ok: false; status: 400 | 413; message: string; reason?: string };

export type IngestInput = {
	body: ReadableStream<Uint8Array> | null;
	siteRef: SiteRef;
	actor: { tokenId?: string | null; userId?: string | null };
	source: 'api' | 'panel-upload';
	notes?: string | null;
	activate: boolean;
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
		const existing = await findReusable(input.siteRef.id, written.checksum);
		if (existing) {
			if (input.activate) await activate(input.siteRef, existing.id);
			return {
				ok: true,
				deploymentId: existing.id,
				fileCount: existing.fileCount,
				totalBytes: existing.totalBytes,
				reused: true,
				skipped: [],
				root: ''
			};
		}

		deploymentId = newId();
		await db.insert(deployment).values({
			id: deploymentId,
			siteId: input.siteRef.id,
			status: 'uploading',
			checksum: written.checksum,
			ingestVersion: INGEST_VERSION,
			source: input.source,
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
				maxRatio: config.MAX_ZIP_RATIO
			}
		);

		await db
			.update(deployment)
			.set({
				status: 'ready',
				fileCount: result.fileCount,
				totalBytes: result.totalBytes,
				readyAt: new Date()
			})
			.where(eq(deployment.id, deploymentId));

		if (input.activate) await activate(input.siteRef, deploymentId);

		return {
			ok: true,
			deploymentId,
			fileCount: result.fileCount,
			totalBytes: result.totalBytes,
			reused: false,
			skipped: result.skipped,
			root: result.root
		};
	} catch (err) {
		if (deploymentId) await markFailed(input.siteRef.id, deploymentId);
		if (err instanceof ZipRejected) {
			return { ok: false, status: 400, message: err.message, reason: err.reason };
		}
		throw err;
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

export async function activate(siteRef: SiteRef, deploymentId: string): Promise<void> {
	await db.update(site).set({ activeDeploymentId: deploymentId }).where(eq(site.id, siteRef.id));
	await invalidateSite(siteRef.slug, siteRef.id);
}

/** Drops the objects and marks the row, so a dead upload leaves nothing behind. */
async function markFailed(siteId: string, deploymentId: string): Promise<void> {
	await deletePrefix(deploymentPrefix(siteId, deploymentId)).catch((err) =>
		console.error('[pagebox] failed to clean up a failed deployment:', err)
	);
	await db
		.update(deployment)
		.set({ status: 'failed' })
		.where(eq(deployment.id, deploymentId))
		.catch(() => {});
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
