import { getConfig } from '../config';
import { lazy } from '../lazy';
import { MemoryCache } from './memory';
import { ValkeyCache } from './valkey';

/**
 * Site metadata and effective grants are read on every asset request, so they are cached
 * for a short TTL. Valkey is optional: without REDIS_URL the process caches in memory,
 * which is correct for a single replica (config.ts refuses to start more than one without
 * a shared cache).
 *
 * The TTL is the correctness floor. Invalidation is an optimisation on top of it, never
 * the only mechanism.
 */
export interface CacheStore {
	get<T>(key: string): Promise<T | undefined>;
	set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
	/** Drops every key starting with the prefix, locally and in other replicas. */
	invalidatePrefix(prefix: string): Promise<void>;
	close(): Promise<void>;
	readonly kind: 'memory' | 'valkey';
}

export const cache: CacheStore = lazy(() => {
	const url = getConfig().REDIS_URL;
	return url ? new ValkeyCache(url) : new MemoryCache();
});

export const CACHE_TTL_SECONDS = 60;

export const cacheKeys = {
	siteBySlug: (slug: string) => `site:slug:${slug}`,
	siteById: (id: string) => `site:id:${id}`,
	sitePrefix: (siteId: string) => `perm:${siteId}:`,
	permission: (siteId: string, userId: string | null) => `perm:${siteId}:${userId ?? 'anon'}`
};
