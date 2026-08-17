import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { getSql, db } from './index';

/** Arbitrary but stable key, so concurrent replicas serialise instead of racing. */
const LOCK_KEY = 0x9a6eb0c1;

/** How long to wait for another instance to finish migrating before giving up. */
const LOCK_WAIT_MS = 60_000;
const RETRY_MS = 500;

/**
 * Applies pending migrations under a Postgres advisory lock.
 *
 * Runs at container start (see startup.ts) because neither Dokploy nor a plain
 * `docker compose up` has a release phase. Idempotent: with nothing pending it costs a
 * couple of round-trips.
 *
 * Two things here are not decoration:
 *
 * - The lock is taken on a **reserved connection**. Advisory locks belong to a session,
 *   and `getSql()` is a pool: taking the lock on one connection and releasing it on
 *   another leaves it held forever, and every later boot then hangs — silently, before the
 *   first log line, which is a miserable thing to debug.
 * - It waits with `pg_try_advisory_lock` instead of blocking on `pg_advisory_lock`, so a
 *   stale holder produces an error that says what happened rather than a process that
 *   never finishes starting.
 */
export async function runMigrations(
	folder = process.env.PAGEBOX_MIGRATIONS_DIR ?? './drizzle'
): Promise<void> {
	const reserved = await getSql().reserve();

	try {
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			const [row] = await reserved<{ locked: boolean }[]>`
				SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked
			`;
			if (row.locked) break;

			if (Date.now() > deadline) {
				throw new Error(
					`another instance has held the migration lock for over ${LOCK_WAIT_MS / 1000}s. ` +
						'If none is running, a stale connection holds it: ' +
						`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = ${LOCK_KEY} AND granted;`
				);
			}
			await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
		}

		try {
			await migrate(db, { migrationsFolder: folder });
		} finally {
			await reserved`SELECT pg_advisory_unlock(${LOCK_KEY})`;
		}
	} finally {
		await reserved.release();
	}
}
