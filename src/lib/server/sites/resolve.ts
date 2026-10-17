import { eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db';
import { site } from '../db/schema';
import { cache, cacheKeys } from '../cache';
import { SLUG_RE } from '../ids';

/**
 * The single entry point that maps (host, path) to a site — PLAN §D1.
 *
 * Two shapes: `<SITES_HOST>/s/<slug>/<subpath>` for a site without a domain, and
 * `<custom domain>/<subpath>` for one an owner gave its own. `serveSite` only ever sees
 * `{ site, subpath }`, whichever it was.
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
	/** Custom domain the site is served from at `/`, or null for `/s/<slug>/`. */
	hostname: string | null;
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

/** A path on the shared sites host: `/s/<slug>/...`. */
export async function resolveSite(host: string, path: string): Promise<ResolvedSite | null> {
	if (host.toLowerCase().split(':')[0] !== config.PAGEBOX_SITES_HOST.split(':')[0]) return null;

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

/** A path on a site's own domain, which serves the build from `/`. */
export function resolveDomainPath(siteRef: SiteRef, path: string): ResolvedSite {
	return { siteRef, subpath: path.replace(/^\//, ''), needsTrailingSlashRedirect: false };
}

/** The site an owner pointed this exact host at, if any. */
export async function lookupSiteByHost(host: string): Promise<SiteRef | null> {
	const hostname = host.toLowerCase();
	if (!hostname) return null;
	const [row] = await db.select().from(site).where(eq(site.hostname, hostname)).limit(1);
	return row ? toRef(row) : null;
}

export async function lookupSiteBySlug(slug: string): Promise<SiteRef | null> {
	const [row] = await db.select().from(site).where(eq(site.slug, slug)).limit(1);
	return row ? toRef(row) : null;
}

function toRef(row: typeof site.$inferSelect): SiteRef {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		visibility: row.visibility,
		basePath: row.basePath,
		hostname: row.hostname,
		spaFallback: row.spaFallback,
		activeDeploymentId: row.activeDeploymentId,
		ownerUserId: row.ownerUserId,
		disabled: row.disabledAt !== null || row.deletingAt !== null,
		retentionLimit: row.retentionLimit
	};
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
