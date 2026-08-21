import Valkey from 'iovalkey';
import type { CacheStore } from './index';

const NS = 'pb:';

/** Shared cache. Required when more than one replica runs (see config.ts). */
export class ValkeyCache implements CacheStore {
	readonly kind = 'valkey' as const;
	#client: Valkey;

	constructor(url: string) {
		this.#client = new Valkey(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
		this.#client.on('error', (err: Error) => {
			// A cache outage must not take the site host down: reads fall back to Postgres.
			console.error('[pagebox] valkey error:', err.message);
		});
	}

	async get<T>(key: string): Promise<T | undefined> {
		try {
			const raw = await this.#client.get(NS + key);
			return raw ? (JSON.parse(raw) as T) : undefined;
		} catch {
			return undefined;
		}
	}

	async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
		try {
			await this.#client.set(NS + key, JSON.stringify(value), 'EX', ttlSeconds);
		} catch {
			/* cache writes are best-effort */
		}
	}

	async delete(key: string): Promise<void> {
		try {
			await this.#client.unlink(NS + key);
		} catch {
			/* TTL remains the correctness floor */
		}
	}

	async invalidatePrefix(prefix: string): Promise<void> {
		try {
			let cursor = '0';
			do {
				const [next, keys] = await this.#client.scan(
					cursor,
					'MATCH',
					`${NS}${prefix}*`,
					'COUNT',
					200
				);
				cursor = next;
				if (keys.length) await this.#client.unlink(...keys);
			} while (cursor !== '0');
		} catch {
			/* TTL remains the correctness floor */
		}
	}

	async close(): Promise<void> {
		try {
			await this.#client.quit();
		} catch {
			this.#client.disconnect();
		}
	}
}
