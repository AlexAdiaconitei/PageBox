import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { config, formatBytes } from './config';
import { db, getSql } from './db';
import { deployment, site, user } from './db/schema';
import { prunablePlan } from './deploy/retention';

/**
 * Storage quotas: how much of the bucket each admin may occupy.
 *
 * The shape, in one paragraph. Usage is every byte an admin's sites still hold — not just
 * what they serve — because a deployment kept for rollback occupies exactly as much disk as
 * the live one. The instance declares a total (`PAGEBOX_STORAGE_BYTES`); quotas are
 * allocated out of it and may never sum past it. The superadmin has no quota of its own: it
 * gets whatever the admins leave over, so every quota it hands out visibly shrinks its own
 * room, which is the right way round for the account that decides.
 *
 * Two things this deliberately is not:
 *
 * - It is not a measurement. S3 exposes no capacity figure — MinIO and Garage report disk
 *   size only through their own non-S3 admin APIs — so the total is a number somebody
 *   writes down, and everything here is arithmetic over it. Left unset, quotas still hold
 *   individually and the pool simply has nothing to say.
 * - It is not a delete order. Lowering a quota below what somebody already stores puts them
 *   *over*, which stops their next upload and touches nothing they have. Reclaiming space is
 *   then their action, or an operator's, never a background job's.
 *
 * Usage is summed live rather than kept in a counter. At the scale this runs at the query
 * is two joins over a few hundred rows, and a counter is a number that drifts the first
 * time something fails between writing the objects and updating it.
 *
 * Because it is summed live, *every* decision that spends or hands out room has to be
 * serialised against the others that touch the same account — see `withQuotaLock`. Read,
 * decide, write is not atomic on its own, and a pool advertised as hard has to be hard
 * under two people pressing deploy at the same moment, not only under one.
 */

/**
 * Serialises the decisions that spend or allocate storage.
 *
 * Everything here is check-then-act over a live `SUM`: two uploads by the same admin, or
 * two quotas handed out at once, each read a figure that the other is about to invalidate,
 * and both pass. Postgres advisory locks are the cheap fix — no row to lock (usage is
 * derived, not stored), no table to serialise, and the lock is released with the session
 * whatever happens to the request.
 *
 * Two scopes. Spending is per owner, so one admin's deploy never waits on another's. The
 * pool is one lock for the instance, because allocating touches every quota at once. The
 * pool lock is taken *inside* an owner lock nowhere, and vice versa — they are disjoint, so
 * there is no ordering to get wrong.
 *
 * The key is a hash rather than the id, because advisory locks are keyed by bigint and
 * ULIDs are not numbers. Collisions cost a needless wait, never a wrong answer.
 */
const LOCK_NAMESPACE = { owner: 0x9b01, pool: 0x9b02 } as const;

function lockKey(scope: keyof typeof LOCK_NAMESPACE, id: string): number {
	// FNV-1a over the id, folded into 31 bits so the pair fits a Postgres (int, int) lock.
	let hash = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 1) | 0;
}

export async function withQuotaLock<T>(
	scope: keyof typeof LOCK_NAMESPACE,
	id: string,
	fn: () => Promise<T>
): Promise<T> {
	// A reserved connection, not the pool: an advisory lock belongs to the session that took
	// it, and taking it on one connection while releasing on another leaks it forever (the
	// same trap `db/migrate.ts` documents).
	const reserved = await getSql().reserve();
	const namespace = LOCK_NAMESPACE[scope];
	const key = lockKey(scope, id);
	try {
		await reserved`SELECT pg_advisory_lock(${namespace}, ${key})`;
		try {
			return await fn();
		} finally {
			await reserved`SELECT pg_advisory_unlock(${namespace}, ${key})`;
		}
	} finally {
		await reserved.release();
	}
}

export type Usage = { bytes: number; deployments: number };

/** Bytes each of these accounts occupies, across every site they own. */
export async function usageByOwner(userIds: string[]): Promise<Map<string, Usage>> {
	const out = new Map<string, Usage>();
	if (userIds.length === 0) return out;

	const rows = await db
		.select({
			ownerUserId: site.ownerUserId,
			bytes: sql<string>`coalesce(sum(${deployment.totalBytes}), 0)`,
			deployments: sql<string>`count(${deployment.id})`
		})
		.from(site)
		.leftJoin(deployment, and(eq(deployment.siteId, site.id), ne(deployment.status, 'failed')))
		.where(inArray(site.ownerUserId, userIds))
		.groupBy(site.ownerUserId);

	for (const row of rows) {
		if (!row.ownerUserId) continue;
		out.set(row.ownerUserId, {
			bytes: Number(row.bytes),
			deployments: Number(row.deployments)
		});
	}
	// A site-less admin is at zero, not absent: every caller wants a figure, not a maybe.
	for (const id of userIds) if (!out.has(id)) out.set(id, { bytes: 0, deployments: 0 });
	return out;
}

export async function usageFor(userId: string): Promise<number> {
	return (await usageByOwner([userId])).get(userId)?.bytes ?? 0;
}

/**
 * Sites whose owner is gone — the FK sets `owner_user_id` null rather than cascading.
 *
 * Named, not just counted: "3.2 GB belongs to nobody" is a fact you cannot act on, and the
 * action needed is to open each of those sites and give it an owner.
 */
export async function unownedSites(): Promise<{ slug: string; bytes: number }[]> {
	const rows = await db
		.select({
			slug: site.slug,
			bytes: sql<string>`coalesce(sum(${deployment.totalBytes}), 0)`
		})
		.from(site)
		.leftJoin(deployment, and(eq(deployment.siteId, site.id), ne(deployment.status, 'failed')))
		.where(isNull(site.ownerUserId))
		.groupBy(site.slug)
		.orderBy(site.slug);
	return rows.map((row) => ({ slug: row.slug, bytes: Number(row.bytes) }));
}

export type PoolState = {
	/** Null when PAGEBOX_STORAGE_BYTES is unset: quotas hold, the pool has nothing to say. */
	total: number | null;
	/** Sum of every admin's quota. */
	allocated: number;
	/** What the superadmin may still hand out. Never negative — see `overAllocated`. */
	free: number;
	/** True when quotas already sum past the total, which lowering the total can cause. */
	overAllocated: boolean;
	/** Admins carrying no quota at all. Only reachable on an instance without them set up. */
	unmetered: number;
	/** The seat's own allowance: whatever the admins leave over. */
	superadminAllowance: number | null;
	superadminUsed: number;
	/** Sites nobody owns: they occupy the bucket and belong to no allocation. */
	orphaned: { slug: string; bytes: number }[];
};

export async function poolState(): Promise<PoolState> {
	const total = config.PAGEBOX_STORAGE_BYTES ?? null;

	const admins = await db
		.select({ id: user.id, quota: user.storageQuotaBytes })
		.from(user)
		.where(eq(user.role, 'admin'));

	const allocated = admins.reduce((sum, row) => sum + (row.quota ?? 0), 0);
	const unmetered = admins.filter((row) => row.quota === null).length;

	const [seat] = await db.select({ id: user.id }).from(user).where(eq(user.role, 'superadmin'));
	const superadminUsed = seat ? await usageFor(seat.id) : 0;

	return {
		total,
		allocated,
		free: total === null ? 0 : Math.max(0, total - allocated),
		overAllocated: total !== null && allocated > total,
		unmetered,
		superadminAllowance: total === null ? null : Math.max(0, total - allocated),
		superadminUsed,
		orphaned: await unownedSites()
	};
}

/**
 * Whether a quota may be set to `wanted` for `targetId`, given everything else allocated.
 *
 * Two ways to say no, and they are different failures: the pool has not got it, or handing
 * it over would leave the seat holding less room than it is already using. The second is
 * the one that surprises people, so it is a message of its own.
 *
 * Call it inside `withQuotaLock('pool', …)` together with the write it guards: on its own
 * it answers a question about a figure that the next request is free to change.
 */
export async function canAllocate(
	targetId: string | null,
	wanted: number
): Promise<{ ok: true } | { ok: false; message: string }> {
	const total = config.PAGEBOX_STORAGE_BYTES;
	if (!total) return { ok: true };

	const admins = await db
		.select({ id: user.id, quota: user.storageQuotaBytes })
		.from(user)
		.where(eq(user.role, 'admin'));

	// The target's current quota is being replaced, not added to.
	const others = admins
		.filter((row) => row.id !== targetId)
		.reduce((sum, row) => sum + (row.quota ?? 0), 0);

	if (others + wanted > total) {
		return {
			ok: false,
			message:
				`Only ${formatBytes(total - others)} is free — ${formatBytes(wanted)} asked for. ` +
				'Lower it, or take some back from another admin.'
		};
	}

	const [seat] = await db.select({ id: user.id }).from(user).where(eq(user.role, 'superadmin'));
	const seatUsed = seat ? await usageFor(seat.id) : 0;
	if (total - (others + wanted) < seatUsed) {
		return {
			ok: false,
			message:
				`That would leave the superadmin ${formatBytes(total - (others + wanted))} while it ` +
				`is already using ${formatBytes(seatUsed)}. Free some of its own storage first.`
		};
	}

	return { ok: true };
}

export type Allowance =
	| { metered: false }
	| {
			metered: true;
			quota: number;
			used: number;
			/** What this site's retention limit would drop to make room for the incoming build. */
			freedByRetention: number;
			/** quota − (used − freedByRetention). Never negative. */
			remaining: number;
			over: boolean;
	  };

/**
 * How many bytes this upload may store.
 *
 * Retention is counted *before* the fact: a site keeping its last three builds is expected
 * to stay level, so an admin at their ceiling whose next deploy would drop two old builds
 * has room for it. `prunablePlan` computes exactly what would go, with `incoming: 1` for the
 * build that has no row yet. The cost is a few seconds where the bucket holds both, since
 * the prune runs after the upload — pruning first would trade real history for an upload
 * that might still fail, which ingest refuses to do.
 */
export async function allowanceFor(
	owner: { id: string; role: string; storageQuotaBytes: number | null },
	siteRef: { id: string; retentionLimit: number | null; activeDeploymentId: string | null }
): Promise<Allowance> {
	const quota = await quotaFor(owner);
	if (quota === null) return { metered: false };

	const used = await usageFor(owner.id);
	const doomed = await prunablePlan(
		siteRef.id,
		siteRef.retentionLimit,
		siteRef.activeDeploymentId,
		1
	);
	const freedByRetention = doomed.reduce((sum, row) => sum + row.totalBytes, 0);
	const effective = Math.max(0, used - freedByRetention);

	return {
		metered: true,
		quota,
		used,
		freedByRetention,
		remaining: Math.max(0, quota - effective),
		over: effective > quota
	};
}

/** The seat's allowance is the remainder; an admin's is its own column; nobody else has one. */
export async function quotaFor(owner: {
	id: string;
	role: string;
	storageQuotaBytes: number | null;
}): Promise<number | null> {
	if (owner.role === 'superadmin') {
		const state = await poolState();
		return state.superadminAllowance;
	}
	return owner.storageQuotaBytes;
}

/** The owner a site's storage is charged to, or null when nobody holds it. */
export async function ownerOf(siteId: string) {
	const [row] = await db
		.select({
			id: user.id,
			role: user.role,
			email: user.email,
			storageQuotaBytes: user.storageQuotaBytes
		})
		.from(site)
		.innerJoin(user, eq(user.id, site.ownerUserId))
		.where(eq(site.id, siteId))
		.limit(1);
	return row ?? null;
}

export const GIB = 1024 * 1024 * 1024;

/**
 * Parses the quota field, which is entered in GiB because nobody types eleven digits.
 * Fractions are allowed — 0.5 GB is a reasonable quota for a documentation site.
 */
export function parseQuota(raw: FormDataEntryValue | null): {
	value: number | null;
	error?: string;
} {
	const text = String(raw ?? '').trim();
	if (!text) return { value: null };

	const parsed = Number(text);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return { value: null, error: 'The quota must be a number of gigabytes' };
	}
	if (parsed === 0) return { value: 0 };
	// Below this the figure stops being a quota and starts being a way to lock somebody out
	// by accident — one build of anything is bigger.
	if (parsed * GIB < 1024 * 1024) {
		return { value: null, error: 'Use at least 0.001 GB, or 0 to stop them storing anything' };
	}
	return { value: Math.round(parsed * GIB) };
}
