import { drizzle } from 'drizzle-orm/postgres-js';
import type { ReservedSql, Sql } from 'postgres';
import { currentConnection, getSql, onConnection, schema, type Db } from './index';

const NAMESPACE = 0x9b03;
const WAIT_MS = 60_000;
const heldLocks = new WeakMap<Db, Set<number>>();

function keyFor(name: string): number {
	let hash = 0x811c9dc5;
	for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
	return hash | 0;
}

/** postgres.js reserved connections omit begin/options; supply transactions on that session. */
export function databaseOnReserved(reserved: ReservedSql): Db {
	let depth = 0;
	let sequence = 0;
	const begin = async <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => {
		const nested = depth > 0;
		const savepoint = `pagebox_tx_${++sequence}`;
		await reserved.unsafe(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
		depth++;
		try {
			const result = await fn(client);
			await reserved.unsafe(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
			return result;
		} catch (error) {
			await reserved.unsafe(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK');
			if (nested) await reserved.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
			throw error;
		} finally {
			depth--;
		}
	};
	// The driver uses unsafe/options/begin/savepoint. Every query stays on reserved.
	const client = Object.assign(reserved, {
		options: getSql().options,
		begin,
		savepoint: begin
	}) as unknown as Sql;
	return drizzle(client, { schema });
}

export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const key = keyFor(name);
	const current = currentConnection();
	if (current && heldLocks.get(current)?.has(key)) return fn();
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		const reserved = current ? null : await getSql().reserve();
		const connection = current ?? databaseOnReserved(reserved!);
		const client = connection.$client;
		let locked = false;
		try {
			const [row] = await client<
				{ locked: boolean }[]
			>`SELECT pg_try_advisory_lock(${NAMESPACE}, ${key}) AS locked`;
			locked = row.locked;
			if (locked) {
				const keys = heldLocks.get(connection) ?? new Set<number>();
				keys.add(key);
				heldLocks.set(connection, keys);
				try {
					return await onConnection(connection, fn);
				} finally {
					keys.delete(key);
				}
			}
		} finally {
			try {
				if (locked) await client`SELECT pg_advisory_unlock(${NAMESPACE}, ${key})`;
			} finally {
				await reserved?.release();
			}
		}
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name} lock`);
		// Waiters return their connection to the pool before sleeping.
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** Quotas, ownership, deployment lifecycle and the pool share one storage invariant. */
export const withStorageLock = <T>(fn: () => Promise<T>) => withLock('storage', fn);
