import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db';
import { deployment } from '../db/schema';
import { deletePrefix, deploymentPrefix } from '../s3';

/**
 * An upload that dies mid-flight leaves a row in `uploading` and orphan objects in S3.
 * Nothing else will ever look at them, so they are swept: at boot, and once an hour.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export async function sweepStaleUploads(): Promise<number> {
	const cutoff = new Date(Date.now() - STALE_AFTER_MS);
	const stale = await db
		.select({ id: deployment.id, siteId: deployment.siteId })
		.from(deployment)
		.where(and(eq(deployment.status, 'uploading'), lt(deployment.createdAt, cutoff)))
		.limit(100);

	for (const row of stale) {
		await deletePrefix(deploymentPrefix(row.siteId, row.id)).catch((err) =>
			console.error(`[pagebox] sweep: could not drop objects of ${row.id}:`, err)
		);
		await db.update(deployment).set({ status: 'failed' }).where(eq(deployment.id, row.id));
	}
	return stale.length;
}

export function startSweeper(): void {
	const run = () =>
		sweepStaleUploads()
			.then((count) => {
				if (count > 0) console.log(`[pagebox] swept ${count} stale upload(s)`);
			})
			.catch((err) => console.error('[pagebox] sweep failed:', err));

	run();
	// Unref'd so the timer never holds the process open during a shutdown.
	setInterval(run, SWEEP_INTERVAL_MS).unref();
}
