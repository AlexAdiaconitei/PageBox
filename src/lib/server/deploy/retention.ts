import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { deployment } from '../db/schema';
import { deletePrefix, deploymentPrefix } from '../s3';
import type { SiteRef } from '../sites/resolve';

/**
 * Deployment retention: keep the newest N, drop what falls off the end.
 *
 * Every deployment is a *whole* copy of the build — that is what makes rollback a pointer
 * move — so a site deployed on every push grows without bound, and the only tool for it
 * used to be deleting rows by hand. A limit set on the site turns that into a rule.
 *
 * Two things it will never do, because a rollback that finds nothing to roll back to is
 * worse than a full bucket:
 *
 * - the live deployment is never pruned, wherever it sits in the order;
 * - deployments still uploading are never pruned (the sweeper in cleanup.ts owns those).
 *
 * Nothing here is silent: `prunablePlan` is what the panel shows before an upload, and
 * `pruneDeployments` returns exactly what it removed so the caller can say so.
 */

/** Below this a "keep the last N" rule stops being retention and starts being deletion. */
export const MIN_RETENTION = 2;
export const MAX_RETENTION = 500;

export type PruneOutcome = {
	prunedIds: string[];
	reclaimedBytes: number;
	/** Over the limit but still there: its objects would not delete. Logged, not fatal. */
	failedIds: string[];
};

/** A deployment retention would drop, oldest last. Pure listing — deletes nothing. */
export async function prunablePlan(
	siteId: string,
	limit: number | null,
	activeDeploymentId: string | null,
	/** Deployments about to exist that the caller has not written yet (the one being uploaded). */
	incoming = 0
): Promise<{ id: string; totalBytes: number; createdAt: Date }[]> {
	if (!limit || limit <= 0) return [];

	const rows = await db
		.select({
			id: deployment.id,
			totalBytes: deployment.totalBytes,
			createdAt: deployment.createdAt
		})
		.from(deployment)
		.where(and(eq(deployment.siteId, siteId), ne(deployment.status, 'uploading')))
		.orderBy(desc(deployment.createdAt));

	// The incoming upload occupies a slot at the top of the list before it has a row, so
	// the panel's warning matches what actually happens once it lands.
	const keep = Math.max(0, limit - incoming);
	const overflow = rows.slice(keep);
	return overflow.filter((row) => row.id !== activeDeploymentId);
}

/** Applies the site's retention limit. Safe to call when there is none — it does nothing. */
export async function pruneDeployments(
	siteRef: Pick<SiteRef, 'id' | 'activeDeploymentId'>,
	limit: number | null
): Promise<PruneOutcome> {
	const doomed = await prunablePlan(siteRef.id, limit, siteRef.activeDeploymentId);
	if (doomed.length === 0) return { prunedIds: [], reclaimedBytes: 0, failedIds: [] };

	const removed: string[] = [];
	const failed: string[] = [];
	let reclaimed = 0;

	for (const row of doomed) {
		try {
			await deletePrefix(deploymentPrefix(siteRef.id, row.id));
		} catch (err) {
			// Leaving the row alive is the right failure: the objects are still referenced
			// by something the panel lists, rather than becoming an orphan nobody can find.
			console.error(`[pagebox] retention: could not drop objects of ${row.id}:`, err);
			failed.push(row.id);
			continue;
		}
		removed.push(row.id);
		reclaimed += row.totalBytes;
	}

	if (removed.length > 0) {
		await db.delete(deployment).where(inArray(deployment.id, removed));
	}

	return { prunedIds: removed, reclaimedBytes: reclaimed, failedIds: failed };
}

/** Total bytes a site occupies across every deployment it still has. */
export async function siteStorage(
	siteIds: string[]
): Promise<Map<string, { bytes: number; deployments: number }>> {
	const out = new Map<string, { bytes: number; deployments: number }>();
	if (siteIds.length === 0) return out;

	const rows = await db
		.select({
			siteId: deployment.siteId,
			bytes: sql<string>`coalesce(sum(${deployment.totalBytes}), 0)`,
			deployments: sql<string>`count(*)`
		})
		.from(deployment)
		.where(and(inArray(deployment.siteId, siteIds), ne(deployment.status, 'failed')))
		.groupBy(deployment.siteId);

	for (const row of rows) {
		out.set(row.siteId, { bytes: Number(row.bytes), deployments: Number(row.deployments) });
	}
	return out;
}

/** Parses what a form sent for the retention field: '' / '0' mean "keep everything". */
export function parseRetention(raw: FormDataEntryValue | null): {
	value: number | null;
	error?: string;
} {
	const text = String(raw ?? '').trim();
	if (!text) return { value: null };

	const parsed = Number(text);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return { value: null, error: 'The retention limit must be a whole number of deployments' };
	}
	if (parsed === 0) return { value: null };
	if (parsed < MIN_RETENTION) {
		return {
			value: null,
			error: `Keep at least ${MIN_RETENTION} deployments, or there is nothing to roll back to`
		};
	}
	if (parsed > MAX_RETENTION) {
		return { value: null, error: `The retention limit tops out at ${MAX_RETENTION}` };
	}
	return { value: parsed };
}
