import { extensionOf } from './mime';

/**
 * Everything about turning a request subpath into candidate object paths inside a
 * deployment, and about what may be served at all. Pure functions: the S3 lookups live in
 * serve.ts, the rules live here where they can be tested exhaustively.
 *
 * Order of resolution (docs/PLAN-static-hosting.md §5):
 *   1. the subpath itself
 *   2. subpath + ".html"          — Next/Fumadocs with trailingSlash: false
 *   3. subpath + "/index.html"    — Docusaurus, Next with trailingSlash: true
 *   4. subpath + "index.html"     — when the subpath already ends in '/'
 *   5. index.html with status 200 — only for SPA sites
 *   6. 404.html with status 404, else a plain 404
 */

export type Candidate = { path: string; status: 200 | 404 };

/** Paths a request may never reach, whatever the deployment contains. */
export function isForbiddenPath(subpath: string): boolean {
	if (subpath.startsWith('__pb/') || subpath === '__pb') return true;
	// Dotfiles at any depth: .git/, .env, .well-known is the one exception people expect,
	// but a static host has no business serving it from user content either.
	return subpath.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Rejects traversal and normalises duplicate slashes. Returns null when the path escapes
 * the deployment root — the S3 key would still be inside our prefix, but a `..` that
 * resolves upwards means the request was crafted, not typed.
 */
export function normaliseSubpath(subpath: string): string | null {
	const parts: string[] = [];
	for (const segment of subpath.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	const normalised = parts.join('/');
	// A trailing slash is meaningful (rule 4), so preserve it.
	return subpath.endsWith('/') && normalised !== '' ? normalised + '/' : normalised;
}

/**
 * Candidate object paths, in the order they must be tried.
 *
 * A subpath whose last segment already has an extension is only tried literally: probing
 * `app.js.html` and `app.js/index.html` would double the S3 round-trips on the hot path,
 * for shapes no generator produces.
 */
export function candidatePaths(subpath: string, options: { spaFallback: boolean }): Candidate[] {
	const candidates: Candidate[] = [];
	const push = (path: string, status: 200 | 404 = 200) => {
		if (path && !candidates.some((c) => c.path === path)) candidates.push({ path, status });
	};

	if (subpath === '') {
		push('index.html');
	} else if (subpath.endsWith('/')) {
		push(subpath + 'index.html');
	} else {
		push(subpath);
		if (extensionOf(subpath) === '') {
			push(subpath + '.html');
			push(subpath + '/index.html');
		}
	}

	// Client-routed apps answer every unknown path with their shell, at status 200.
	if (options.spaFallback) push('index.html');

	push('404.html', 404);
	return candidates;
}

/**
 * Content-addressed assets: the name changes whenever the bytes change, so they can be
 * cached forever. Anything else revalidates, or a deploy would not be visible.
 */
export function isImmutableAsset(path: string): boolean {
	if (/(^|\/)(_next\/static|_astro|_app\/immutable)\//.test(path)) return true;
	const name = path.slice(path.lastIndexOf('/') + 1);
	// app.4f3a91b2.js, app-4f3a91b2.js, chunk.DA1z_9Qk.css
	return /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(name) && /\d/.test(name);
}

/** Precompressed sibling a client accepting `encoding` could be served instead. */
export function encodedPathFor(path: string, encoding: 'br' | 'gzip'): string {
	return path + (encoding === 'br' ? '.br' : '.gz');
}

/** Best encoding the client accepts, in our order of preference. */
export function negotiateEncoding(acceptEncoding: string | null): 'br' | 'gzip' | null {
	if (!acceptEncoding) return null;
	const accepted = acceptEncoding.toLowerCase();
	// Ignore explicit q=0 rejections; anything subtler than that is not worth the code.
	const rejects = (token: string) => new RegExp(`${token}\\s*;\\s*q=0(\\.0+)?(,|$)`).test(accepted);
	if (accepted.includes('br') && !rejects('br')) return 'br';
	if (accepted.includes('gzip') && !rejects('gzip')) return 'gzip';
	return null;
}
