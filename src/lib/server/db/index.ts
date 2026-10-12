import { drizzle } from 'drizzle-orm/postgres-js';
import { AsyncLocalStorage } from 'node:async_hooks';
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

const defaultDb = lazy(() => drizzle(getSql(), { schema }));
const connectionContext = new AsyncLocalStorage<Db>();

// All queries inside a lock must use its connection, including queries made by adapters.
export const db: Db = new Proxy({} as Db, {
	get(_target, property) {
		const current = connectionContext.getStore() ?? defaultDb;
		const value = Reflect.get(current, property, current);
		return typeof value === 'function' ? value.bind(current) : value;
	}
});

export function currentConnection(): Db | undefined {
	return connectionContext.getStore();
}

export function onConnection<T>(connection: Db, fn: () => Promise<T>): Promise<T> {
	return connectionContext.run(connection, fn);
}

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export { schema };
