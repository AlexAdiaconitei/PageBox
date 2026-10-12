import { describe, expect, it } from 'vitest';
import {
	candidatePaths,
	decodeSubpath,
	encodedPathFor,
	isForbiddenPath,
	isImmutableAsset,
	negotiateEncoding,
	normaliseSubpath
} from '../../src/lib/server/sites/paths';
import { contentTypeFor, isCompressible, isHtml } from '../../src/lib/server/sites/mime';

describe('candidatePaths', () => {
	const plain = { spaFallback: false };

	it('serves index.html at the site root', () => {
		expect(candidatePaths('', plain)).toEqual([
			{ path: 'index.html', status: 200 },
			{ path: '404.html', status: 404 }
		]);
	});

	// Rules 1-3: extensionless paths cover Next, Fumadocs and Docusaurus layouts.
	it('tries the extensionless variants in order', () => {
		expect(candidatePaths('guide', plain).map((c) => c.path)).toEqual([
			'guide',
			'guide.html',
			'guide/index.html',
			'404.html'
		]);
	});

	it('maps a trailing slash straight to index.html', () => {
		expect(candidatePaths('guide/', plain).map((c) => c.path)).toEqual([
			'guide/index.html',
			'404.html'
		]);
	});

	// Probing app.js.html on every asset would double S3 round-trips on the hot path.
	it('does not invent variants for paths that already have an extension', () => {
		expect(candidatePaths('assets/app.js', plain).map((c) => c.path)).toEqual([
			'assets/app.js',
			'404.html'
		]);
	});

	it('adds the SPA shell before the 404, with status 200', () => {
		expect(candidatePaths('deep/route', { spaFallback: true })).toEqual([
			{ path: 'deep/route', status: 200 },
			{ path: 'deep/route.html', status: 200 },
			{ path: 'deep/route/index.html', status: 200 },
			{ path: 'index.html', status: 200 },
			{ path: '404.html', status: 404 }
		]);
	});

	it('answers a directory-style route with the SPA shell too', () => {
		expect(candidatePaths('deep/route/', { spaFallback: true })).toEqual([
			{ path: 'deep/route/index.html', status: 200 },
			{ path: 'index.html', status: 200 },
			{ path: '404.html', status: 404 }
		]);
	});

	// A missing chunk must fail as a missing chunk: index.html under nosniff is a MIME error
	// in the browser, and the post-deploy check would count the chunk as present.
	it('never answers a missing asset with the SPA shell', () => {
		expect(candidatePaths('assets/index-DA1z9Qk0.js', { spaFallback: true })).toEqual([
			{ path: 'assets/index-DA1z9Qk0.js', status: 200 },
			{ path: '404.html', status: 404 }
		]);
		expect(candidatePaths('missing.html', { spaFallback: true }).map((c) => c.path)).toEqual([
			'missing.html',
			'404.html'
		]);
	});

	it('never repeats a candidate', () => {
		const paths = candidatePaths('', { spaFallback: true }).map((c) => c.path);
		expect(paths).toEqual([...new Set(paths)]);
	});
});

describe('decodeSubpath', () => {
	it('decodes spaces and Unicode once', () => {
		expect(decodeSubpath('hello%20world.txt')).toBe('hello world.txt');
		expect(decodeSubpath('caf%C3%A9.txt')).toBe('café.txt');
	});
	it('refuses separators, traversal, nested escapes and malformed encoding', () => {
		for (const path of [
			'a%2fb',
			'a%5cb',
			'%2e%2e/file',
			'%252e%252e/file',
			'%00',
			'%zz',
			'%c0%ae'
		]) {
			expect(decodeSubpath(path), path).toBeNull();
		}
	});
});

describe('normaliseSubpath', () => {
	it('collapses redundant segments', () => {
		expect(normaliseSubpath('a//b/./c')).toBe('a/b/c');
		expect(normaliseSubpath('a/b/../c')).toBe('a/c');
	});

	it('keeps a meaningful trailing slash', () => {
		expect(normaliseSubpath('guide/')).toBe('guide/');
		expect(normaliseSubpath('')).toBe('');
	});

	it('rejects traversal out of the deployment root', () => {
		expect(normaliseSubpath('../etc/passwd')).toBeNull();
		expect(normaliseSubpath('a/../../b')).toBeNull();
	});
});

describe('isForbiddenPath', () => {
	it('blocks dotfiles at any depth', () => {
		expect(isForbiddenPath('.env')).toBe(true);
		expect(isForbiddenPath('.git/config')).toBe(true);
		expect(isForbiddenPath('assets/.DS_Store')).toBe(true);
	});

	it('blocks the internal namespace', () => {
		expect(isForbiddenPath('__pb/cb')).toBe(true);
		expect(isForbiddenPath('__pb')).toBe(true);
	});

	it('allows ordinary content', () => {
		expect(isForbiddenPath('index.html')).toBe(false);
		expect(isForbiddenPath('_next/static/chunk.js')).toBe(false);
	});
});

describe('isImmutableAsset', () => {
	it('recognises hashed filenames and known immutable directories', () => {
		expect(isImmutableAsset('_next/static/chunks/main-4f3a91b2.js')).toBe(true);
		expect(isImmutableAsset('_astro/index.BAr9Xk21.css')).toBe(true);
		expect(isImmutableAsset('assets/index-DA1z9Qk0.js')).toBe(true);
	});

	it('leaves unhashed files revalidating', () => {
		expect(isImmutableAsset('index.html')).toBe(false);
		expect(isImmutableAsset('images/logo.png')).toBe(false);
		expect(isImmutableAsset('style.css')).toBe(false);
	});
});

describe('encoding negotiation', () => {
	it('prefers brotli, then gzip', () => {
		expect(negotiateEncoding('gzip, deflate, br')).toBe('br');
		expect(negotiateEncoding('gzip, deflate')).toBe('gzip');
		expect(negotiateEncoding('deflate')).toBeNull();
		expect(negotiateEncoding(null)).toBeNull();
	});

	it('honours an explicit q=0', () => {
		expect(negotiateEncoding('br;q=0, gzip')).toBe('gzip');
	});

	it('honours quality weights and exact encoding tokens', () => {
		expect(negotiateEncoding('br;q=0.1, gzip;q=1')).toBe('gzip');
		expect(negotiateEncoding('zebra, xgzip')).toBeNull();
		expect(negotiateEncoding('br ; q=0 , gzip')).toBe('gzip');
		expect(negotiateEncoding('*;q=1, br;q=0')).toBe('gzip');
	});

	it('names the sibling object', () => {
		expect(encodedPathFor('app.js', 'br')).toBe('app.js.br');
		expect(encodedPathFor('app.js', 'gzip')).toBe('app.js.gz');
	});
});

describe('mime', () => {
	it('types from the extension, defaulting to octet-stream', () => {
		expect(contentTypeFor('a/index.html')).toBe('text/html; charset=utf-8');
		expect(contentTypeFor('a/app.js')).toBe('text/javascript; charset=utf-8');
		expect(contentTypeFor('a/font.woff2')).toBe('font/woff2');
		expect(contentTypeFor('a/binary.unknownext')).toBe('application/octet-stream');
		expect(contentTypeFor('LICENSE')).toBe('application/octet-stream');
	});

	it('knows what is worth compressing and what is html', () => {
		expect(isCompressible('app.css')).toBe(true);
		expect(isCompressible('photo.png')).toBe(false);
		expect(isHtml('guide/index.html')).toBe(true);
		expect(isHtml('guide/index.htm')).toBe(true);
		expect(isHtml('app.js')).toBe(false);
	});
});
