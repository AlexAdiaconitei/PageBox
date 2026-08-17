import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { getConfig } from '../config';
import { lazy } from '../lazy';
import * as schema from './schema';

/**
 * One connection pool per process, created on first use (see lazy.ts for why not at
 * import time). `postgres.js` is itself lazy, so the socket opens with the first query.
 */
let pool: Sql | undefined;

export function getSql(): Sql {
	if (!pool) {
		const config = getConfig();
		pool = postgres(config.DATABASE_URL, {
			max: config.DATABASE_POOL_MAX,
			// Startup tasks should fail fast rather than hang a boot.
			connect_timeout: 15,
			onnotice: () => {}
		});
	}
	return pool;
}

export const db = lazy(() => drizzle(getSql(), { schema }));

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export { schema };
