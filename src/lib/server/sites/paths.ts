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
 *   5. index.html with status 200 — only for SPA sites, and only for paths with no extension
 *   6. 404.html with status 404, else a plain 404
 */

export type Candidate = { path: string; status: 200 | 404 };

/** Decode once per segment, before validation. Encoded separators and nested escapes are refused. */
export function decodeSubpath(path: string): string | null {
	try {
		const parts = path.split('/').map((segment) => decodeURIComponent(segment));
		if (
			parts.some(
				(segment) =>
					segment === '.' || segment === '..' || /[/\\\x00-\x1f\x7f]|%[0-9a-f]{2}/i.test(segment)
			)
		)
			return null;
		return parts.join('/');
	} catch {
		return null;
	}
}

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

	// A trailing slash leaves no last segment, so it can never name a file.
	const looksLikeFile = !subpath.endsWith('/') && extensionOf(subpath) !== '';

	if (subpath === '') {
		push('index.html');
	} else if (subpath.endsWith('/')) {
		push(subpath + 'index.html');
	} else {
		push(subpath);
		if (!looksLikeFile) {
			push(subpath + '.html');
			push(subpath + '/index.html');
		}
	}

	// Client-routed apps answer every unknown route with their shell, at status 200 — but
	// only routes. A missing `app-4f3a91b2.js` answered with index.html arrives as text/html
	// under nosniff: the browser refuses it with a MIME error instead of a 404, and the
	// post-deploy check counts the missing chunk as present.
	if (options.spaFallback && !looksLikeFile) push('index.html');

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
	return negotiateEncodings(acceptEncoding)[0] ?? null;
}

/** Try each accepted sibling in quality order before falling back to the plain file. */
export function negotiateEncodings(acceptEncoding: string | null): ('br' | 'gzip')[] {
	if (!acceptEncoding) return [];
	const qualities = new Map<string, number>();
	for (const part of acceptEncoding.toLowerCase().split(',')) {
		const [token, ...parameters] = part.trim().split(';');
		const qualityParameter = parameters.find((parameter) => /^\s*q\s*=/.test(parameter));
		const value = qualityParameter?.split('=')[1]?.trim();
		const quality =
			value === undefined
				? 1
				: /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)
					? Number(value)
					: 0;
		qualities.set(token.trim(), quality);
	}
	const qualityFor = (token: string) => qualities.get(token) ?? qualities.get('*') ?? 0;
	return (['br', 'gzip'] as const)
		.filter((token) => qualityFor(token) > 0)
		.sort((a, b) => qualityFor(b) - qualityFor(a));
}
