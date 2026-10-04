import { and, eq, lt, or } from 'drizzle-orm';
import { db } from '../db';
import { withStorageLock } from '../db/locks';
import { deployment, site } from '../db/schema';
import { deletePrefix, deploymentPrefix } from '../s3';
import { deleteDeployment, deleteSite } from './lifecycle';

/**
 * An upload that dies mid-flight leaves a row in `uploading` and orphan objects in S3.
 * Nothing else will ever look at them, so they are swept: at boot, and once an hour.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export async function sweepStaleUploads(): Promise<number> {
	return withStorageLock(async () => {
		const cutoff = new Date(Date.now() - STALE_AFTER_MS);
		const stale = await db
			.select({ id: deployment.id, siteId: deployment.siteId })
			.from(deployment)
			.where(
				or(
					and(eq(deployment.status, 'uploading'), lt(deployment.createdAt, cutoff)),
					eq(deployment.status, 'cleanup_pending'),
					eq(deployment.status, 'deleting')
				)
			)
			.limit(100);

		let completed = 0;
		for (const row of stale) {
			try {
				const [current] = await db
					.select()
					.from(deployment)
					.where(eq(deployment.id, row.id))
					.limit(1);
				if (!current) continue;
				if (current.status === 'deleting') {
					await deleteDeployment(row.siteId, row.id);
				} else {
					await db
						.update(deployment)
						.set({ status: 'cleanup_pending' })
						.where(eq(deployment.id, row.id));
					await deletePrefix(deploymentPrefix(row.siteId, row.id));
					await db
						.update(deployment)
						.set({ status: 'failed', totalBytes: 0 })
						.where(eq(deployment.id, row.id));
				}
				completed++;
			} catch (err) {
				console.error(`[pagebox] sweep: cleanup of ${row.id} remains pending:`, err);
			}
		}
		const pendingSites = await db
			.select({ id: site.id })
			.from(site)
			.where(lt(site.deletingAt, new Date()))
			.limit(100);
		for (const row of pendingSites) {
			try {
				await deleteSite(row.id);
				completed++;
			} catch (err) {
				console.error(`[pagebox] sweep: deletion of site ${row.id} remains pending:`, err);
			}
		}
		return completed;
	});
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
