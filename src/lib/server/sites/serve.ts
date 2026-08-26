import { Readable } from 'node:stream';
import type { RequestEvent } from '@sveltejs/kit';
import { cache } from '../cache';
import { config } from '../config';
import { errorResponse, isNavigation, notFoundResponse } from '../errorPage';
import { atLeast, permissionFor } from '../perms';
import { getObject, headObject, objectKey, type ObjectHead } from '../s3';
import { contentTypeFor, isCompressible, isHtml } from './mime';
import {
	candidatePaths,
	encodedPathFor,
	isForbiddenPath,
	isImmutableAsset,
	negotiateEncoding,
	normaliseSubpath,
	type Candidate
} from './paths';
import type { ResolvedSite, SiteRef } from './resolve';

/**
 * Serves one file of a deployment, straight from S3.
 *
 * PageBox proxies the bytes itself for public sites too. Splitting it (nginx for public,
 * app for private) would mean two 404/redirect/Content-Type semantics that drift apart,
 * and Garage's web endpoint authenticates nothing — one path, one semantic.
 */

const ENCODING_MISS_TTL = 300;

export async function serveSite(event: RequestEvent, hit: ResolvedSite): Promise<Response> {
	const { siteRef } = hit;

	if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
		return errorResponse(event.request, {
			status: 405,
			title: 'Method not allowed',
			detail: 'This host only serves files. It answers GET and HEAD, and nothing else.',
			note: 'A form posting to a hosted page has nowhere to post to — PageBox stores static files, it runs no code for them.',
			brand: 'sites',
			host: config.PAGEBOX_SITES_HOST,
			headers: { allow: 'GET, HEAD' }
		});
	}

	// Checked before the visibility branch, and before any grant lookup: a suspended site
	// is off for everybody, its owner included. The 404 is the same one everything else
	// here answers, so "taken down" and "never existed" stay indistinguishable from outside.
	if (siteRef.disabled) return notFound(event, siteRef);

	if (siteRef.visibility === 'private') {
		const denial = await guardPrivate(event, siteRef);
		if (denial) return denial;
	}

	if (!siteRef.activeDeploymentId) return notFound(event, siteRef);

	const subpath = normaliseSubpath(hit.subpath);
	if (subpath === null || isForbiddenPath(subpath)) return notFound(event, siteRef);

	const deploymentId = siteRef.activeDeploymentId;
	const candidates = candidatePaths(subpath, { spaFallback: siteRef.spaFallback });

	const found = await locate(siteRef.id, deploymentId, candidates, event);
	if (!found) return notFound(event, siteRef);

	return respond(event, siteRef, found);
}

/**
 * Authorisation for a private site, applied to *every* file — the HTML and each asset it
 * pulls. A design where only the HTML is checked leaves the content readable to anyone who
 * knows an asset URL.
 *
 * Returns a response when the request must not proceed, or null when it may.
 */
async function guardPrivate(event: RequestEvent, siteRef: SiteRef): Promise<Response | null> {
	const permission = await permissionFor(event.locals.user, siteRef);
	if (atLeast(permission, 'viewer')) return null;

	// Signed in but not granted: the same 404 as a site that does not exist. Anything
	// else would confirm which private sites are hosted here.
	if (event.locals.user) return notFound(event, siteRef);

	// Not signed in. Only a navigation may be sent to the login page: a 302 answering a
	// <script src> or a fetch() arrives as HTML where code was expected, and the page
	// breaks in silence halfway through a session expiring.
	if (!isNavigation(event.request)) {
		return errorResponse(event.request, {
			status: 401,
			title: 'Sign in required',
			detail: 'This file belongs to a private site and the request carried no session.',
			brand: 'sites',
			host: config.PAGEBOX_SITES_HOST,
			headers: {
				'cache-control': 'private, no-store',
				'cdn-cache-control': 'no-store',
				vary: 'Cookie'
			}
		});
	}

	const next = event.url.pathname + event.url.search;
	return new Response(null, {
		status: 302,
		headers: {
			location: `/login?next=${encodeURIComponent(next)}`,
			'cache-control': 'private, no-store',
			'cdn-cache-control': 'no-store',
			vary: 'Cookie'
		}
	});
}

type Found = {
	candidate: Candidate;
	/** Object actually stored: the candidate itself, or its `.br`/`.gz` sibling. */
	key: string;
	encoding: 'br' | 'gzip' | null;
	head: ObjectHead;
};

/** Walks the candidates in order and returns the first one that exists. */
async function locate(
	siteId: string,
	deploymentId: string,
	candidates: Candidate[],
	event: RequestEvent
): Promise<Found | null> {
	const range = event.request.headers.get('range');
	// Range and Content-Encoding do not combine: byte offsets into a compressed sibling
	// mean nothing to the client, so a ranged request always gets the plain object.
	const wanted = range ? null : negotiateEncoding(event.request.headers.get('accept-encoding'));

	for (const candidate of candidates) {
		if (wanted && isCompressible(candidate.path)) {
			const encodedKey = objectKey(siteId, deploymentId, encodedPathFor(candidate.path, wanted));
			if (await encodingWorthTrying(deploymentId, wanted)) {
				const head = await headObject(encodedKey);
				if (head) return { candidate, key: encodedKey, encoding: wanted, head };
				// Most deployments ship no precompressed files. Remember that for this
				// deployment so the miss costs one round-trip, not one per asset.
				await cache.set(encodingKey(deploymentId, wanted), false, ENCODING_MISS_TTL);
			}
		}

		const key = objectKey(siteId, deploymentId, candidate.path);
		const head = await headObject(key);
		if (head) return { candidate, key, encoding: null, head };
	}
	return null;
}

async function encodingWorthTrying(deploymentId: string, encoding: 'br' | 'gzip') {
	return (await cache.get<boolean>(encodingKey(deploymentId, encoding))) !== false;
}

const encodingKey = (deploymentId: string, encoding: string) => `enc:${deploymentId}:${encoding}`;

async function respond(event: RequestEvent, siteRef: SiteRef, found: Found): Promise<Response> {
	const headers = new Headers({
		'content-type': contentTypeFor(found.candidate.path),
		'x-content-type-options': 'nosniff',
		'accept-ranges': 'bytes'
	});
	if (found.head.etag) headers.set('etag', found.head.etag);
	if (found.head.lastModified) headers.set('last-modified', found.head.lastModified.toUTCString());
	if (found.encoding) {
		headers.set('content-encoding', found.encoding);
		headers.set('vary', 'Accept-Encoding');
	}
	applyCachePolicy(headers, siteRef, found);

	// Never emit Service-Worker-Allowed: the default scope rule is the only barrier
	// between two sites sharing this origin, and that header would remove it.

	if (found.head.etag && matchesEtag(event.request.headers.get('if-none-match'), found.head.etag)) {
		headers.delete('content-type');
		return new Response(null, { status: 304, headers });
	}

	if (event.request.method === 'HEAD') {
		headers.set('content-length', String(found.head.size));
		return new Response(null, { status: found.candidate.status, headers });
	}

	const range = event.request.headers.get('range') ?? undefined;
	const object = await getObject(found.key, range);
	// Vanished between HEAD and GET: a deployment being deleted underneath us.
	if (!object) return notFound(event, siteRef);

	headers.set('content-length', String(object.contentLength));
	if (object.contentRange) headers.set('content-range', object.contentRange);

	const status = object.status === 206 ? 206 : found.candidate.status;
	return new Response(Readable.toWeb(object.body) as ReadableStream, { status, headers });
}

/**
 * Cache policy, applied last so it always wins.
 *
 * The private-site branch is the security-critical one: if a private asset is cached at
 * Cloudflare's edge it becomes reachable without a session. `Cache-Control` alone is not
 * enough — a Cache Rule can override it — hence the CDN-specific headers too.
 */
function applyCachePolicy(headers: Headers, siteRef: SiteRef, found: Found): void {
	if (siteRef.visibility === 'private') {
		headers.set('cache-control', 'private, no-store');
		headers.set('cdn-cache-control', 'no-store');
		headers.set('cloudflare-cdn-cache-control', 'no-store');
		headers.append('vary', 'Cookie');
		return;
	}

	if (found.candidate.status === 404 || isHtml(found.candidate.path)) {
		// HTML must revalidate or a deploy stays invisible behind the edge cache.
		headers.set('cache-control', 'public, no-cache');
		return;
	}
	headers.set(
		'cache-control',
		isImmutableAsset(found.candidate.path)
			? 'public, max-age=31536000, immutable'
			: 'public, no-cache'
	);
}

/** Weak comparison is enough: we only ever compare against our own S3 ETag. */
function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
	if (!ifNoneMatch) return false;
	if (ifNoneMatch.trim() === '*') return true;
	const normalise = (value: string) => value.trim().replace(/^W\//, '');
	return ifNoneMatch.split(',').some((value) => normalise(value) === normalise(etag));
}

/**
 * One 404 for every reason: missing site, missing file, no deployment, or a private site
 * the caller may not see. Distinguishing them would confirm that a private site exists.
 *
 * The page is the instance-wide one (see errorPage.ts) — the same document the host
 * dispatch answers with for a slug that resolves to nothing, so a site removed from live
 * and a slug that was never registered are one answer down to the byte. What differs here
 * is only the caching: a private site's 404 must not be stored anywhere, because whether
 * it is a 404 depends on who asked.
 */
function notFound(event: RequestEvent, siteRef?: SiteRef): Response {
	const headers: Record<string, string> =
		siteRef?.visibility === 'private'
			? {
					'cache-control': 'private, no-store',
					'cdn-cache-control': 'no-store',
					'cloudflare-cdn-cache-control': 'no-store',
					vary: 'Cookie'
				}
			: { 'cache-control': 'public, no-cache' };
	return notFoundResponse(event.request, 'sites', headers);
}
