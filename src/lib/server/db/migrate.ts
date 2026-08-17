import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { getSql, db } from './index';

/** Arbitrary but stable key, so concurrent replicas serialise instead of racing. */
const LOCK_KEY = 0x9a6eb0c1;

/**
 * Applies pending migrations under a Postgres advisory lock.
 *
 * Runs at container start (see startup.ts) because neither Dokploy nor a plain
 * `docker compose up` has a release phase. Idempotent: with nothing pending it costs a
 * couple of round-trips.
 */
export async function runMigrations(
	folder = process.env.PAGEBOX_MIGRATIONS_DIR ?? './drizzle'
): Promise<void> {
	const sql = getSql();
	await sql`SELECT pg_advisory_lock(${LOCK_KEY})`;
	try {
		await migrate(db, { migrationsFolder: folder });
	} finally {
		await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`;
	}
}
