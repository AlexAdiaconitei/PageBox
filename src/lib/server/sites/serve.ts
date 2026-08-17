import { Readable } from 'node:stream';
import type { RequestEvent } from '@sveltejs/kit';
import { cache } from '../cache';
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
		return new Response('Method not allowed', {
			status: 405,
			headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' }
		});
	}

	// TODO(M4): private sites need a session and a grant check here. Until that exists,
	// answering 404 is the only safe reading of "private".
	if (siteRef.visibility === 'private') return notFound(siteRef);

	if (!siteRef.activeDeploymentId) return notFound(siteRef);

	const subpath = normaliseSubpath(hit.subpath);
	if (subpath === null || isForbiddenPath(subpath)) return notFound(siteRef);

	const deploymentId = siteRef.activeDeploymentId;
	const candidates = candidatePaths(subpath, { spaFallback: siteRef.spaFallback });

	const found = await locate(siteRef.id, deploymentId, candidates, event);
	if (!found) return notFound(siteRef);

	return respond(event, siteRef, found);
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
	if (!object) return notFound(siteRef);

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
 */
function notFound(siteRef?: SiteRef): Response {
	const headers = new Headers({
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': siteRef?.visibility === 'private' ? 'private, no-store' : 'public, no-cache',
		'x-content-type-options': 'nosniff'
	});
	if (siteRef?.visibility === 'private') {
		headers.set('cdn-cache-control', 'no-store');
		headers.set('cloudflare-cdn-cache-control', 'no-store');
		headers.set('vary', 'Cookie');
	}
	return new Response('Not found', { status: 404, headers });
}
