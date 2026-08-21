import type { CacheStore } from './index';

type Entry = { value: unknown; expiresAt: number };

/** Single-process cache: a Map plus lazy expiry and a hard cap to bound memory. */
export class MemoryCache implements CacheStore {
	readonly kind = 'memory' as const;
	#map = new Map<string, Entry>();
	#max: number;

	constructor(max = 5000) {
		this.#max = max;
	}

	async get<T>(key: string): Promise<T | undefined> {
		const hit = this.#map.get(key);
		if (!hit) return undefined;
		if (hit.expiresAt <= Date.now()) {
			this.#map.delete(key);
			return undefined;
		}
		return hit.value as T;
	}

	async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
		if (this.#map.size >= this.#max) {
			// Cheapest useful eviction: drop the oldest insertion.
			const oldest = this.#map.keys().next();
			if (!oldest.done) this.#map.delete(oldest.value);
		}
		this.#map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
	}

	async delete(key: string): Promise<void> {
		this.#map.delete(key);
	}

	async invalidatePrefix(prefix: string): Promise<void> {
		for (const key of this.#map.keys()) {
			if (key.startsWith(prefix)) this.#map.delete(key);
		}
	}

	async close(): Promise<void> {
		this.#map.clear();
	}
}
