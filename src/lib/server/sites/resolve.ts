import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db';
import { site } from '../db/schema';
import { cache, cacheKeys, CACHE_TTL_SECONDS } from '../cache';
import { SLUG_RE } from '../ids';

/**
 * The single entry point that maps (host, path) to a site — PLAN §D1.
 *
 * v1 resolves `<SITES_HOST>/s/<slug>/<subpath>`. v2 (per-site subdomain, §12) adds a
 * branch here and nothing else changes: `serveSite` only ever sees `{ site, subpath }`.
 */

export type ResolvedSite = {
	siteRef: SiteRef;
	/** Path inside the site, without a leading slash. '' means the site root. */
	subpath: string;
	/** True when the URL was `/s/<slug>` with no trailing slash — caller must 301. */
	needsTrailingSlashRedirect: boolean;
};

export type SiteRef = {
	id: string;
	slug: string;
	name: string;
	visibility: 'public' | 'private';
	basePath: string;
	spaFallback: boolean;
	activeDeploymentId: string | null;
	ownerUserId: string | null;
	/** Suspended by an operator: it keeps everything it has and answers nothing. */
	disabled: boolean;
	/** How many deployments to keep on the next upload; null = keep everything. */
	retentionLimit: number | null;
};

/** Pure part: does this path look like a site path, and which slug/subpath is it? */
export function parseSitePath(
	path: string
): { slug: string; subpath: string; needsTrailingSlashRedirect: boolean } | null {
	const prefix = config.PAGEBOX_SITES_PREFIX; // '/s'
	if (!path.startsWith(prefix + '/')) return null;

	const rest = path.slice(prefix.length + 1);
	const slash = rest.indexOf('/');
	const slug = slash === -1 ? rest : rest.slice(0, slash);
	if (!SLUG_RE.test(slug)) return null;

	if (slash === -1) {
		// `/s/<slug>` — every relative URL in the HTML would resolve one level too high.
		return { slug, subpath: '', needsTrailingSlashRedirect: true };
	}
	return { slug, subpath: rest.slice(slash + 1), needsTrailingSlashRedirect: false };
}

export async function resolveSite(host: string, path: string): Promise<ResolvedSite | null> {
	const hostname = host.toLowerCase().split(':')[0];
	if (hostname !== config.PAGEBOX_SITES_HOST.split(':')[0]) return null;

	const parsed = parseSitePath(path);
	if (!parsed) return null;

	const siteRef = await lookupSiteBySlug(parsed.slug);
	// A disabled site is resolved but not served: `serveSite` answers the same 404 as a
	// site that does not exist, so taking one down leaks nothing about what is hosted here.
	if (!siteRef) return null;

	return {
		siteRef,
		subpath: parsed.subpath,
		needsTrailingSlashRedirect: parsed.needsTrailingSlashRedirect
	};
}

export async function lookupSiteBySlug(slug: string): Promise<SiteRef | null> {
	const key = cacheKeys.siteBySlug(slug);
	const cached = await cache.get<SiteRef | 'missing'>(key);
	if (cached === 'missing') return null;
	if (cached) return cached;

	const [row] = await db.select().from(site).where(eq(site.slug, slug)).limit(1);
	if (!row) {
		await cache.set(key, 'missing', CACHE_TTL_SECONDS);
		return null;
	}

	const ref: SiteRef = {
		id: row.id,
		slug: row.slug,
		name: row.name,
		visibility: row.visibility,
		basePath: row.basePath,
		spaFallback: row.spaFallback,
		activeDeploymentId: row.activeDeploymentId,
		ownerUserId: row.ownerUserId,
		disabled: row.disabledAt !== null,
		retentionLimit: row.retentionLimit
	};
	await cache.set(key, ref, CACHE_TTL_SECONDS);
	return ref;
}

/**
 * Drops what this site has cached: its own row, and every permission computed against it.
 *
 * The slug is an exact delete, not a prefix drop. Slugs are not prefix-delimited, so
 * invalidating `demo` used to take `demo-api` and `demo-private` with it — harmless, but
 * only by luck, and it made the cost of an edit proportional to how many sites shared a
 * name stem. `slug` may be null when the caller only knows the id (a grant to a group being
 * deleted, say); the permission entries are what matter there and the site row expires on
 * its own TTL.
 */
export async function invalidateSite(slug: string | null, siteId: string): Promise<void> {
	await Promise.all([
		slug ? cache.delete(cacheKeys.siteBySlug(slug)) : Promise.resolve(),
		cache.invalidatePrefix(cacheKeys.sitePrefix(siteId))
	]);
}
