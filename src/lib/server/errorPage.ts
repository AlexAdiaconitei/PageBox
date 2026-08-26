import { config, type HostKind } from './config';

/**
 * The error pages PageBox serves from outside the router.
 *
 * Most of what answers 4xx here never reaches SvelteKit: the host dispatch in
 * hooks.server.ts and the whole site-serving path in sites/serve.ts return their own
 * `Response`, because they run before — or instead of — route resolution. Every one of
 * them used to be `new Response('Not found', …)`, which a browser shows as one line of
 * text on a white page, in the default serif, with no indication of whose server said it.
 *
 * So this module renders that answer once, as a self-contained document: no stylesheet, no
 * script, no image, no font file. An error page that depends on assets is an error page
 * that breaks exactly when assets are what broke, and on the sites host those assets would
 * be fetched from an origin whose whole job is serving somebody else's files.
 *
 * Two rules the copy follows, both load-bearing:
 *
 *  - **Nothing from the request is reflected.** The requested path never appears on the
 *    page. The sites host is one origin shared by every deployment, so an HTML document
 *    that echoes a crafted URL is an XSS against every other site on it — not a bet worth
 *    taking on an escaping function, for a string the visitor can already see in the
 *    address bar.
 *  - **One 404 says one thing.** Unknown slug, suspended site, site with no live
 *    deployment, private site the caller may not see: identical page, identical wording.
 *    Distinguishing them would confirm which private sites exist here (PLAN §7). The copy
 *    is written so that this is *stated* rather than merely true — the visitor is told that
 *    a site taken out of live and a site that never existed answer the same, which is the
 *    honest response to "was this ever here?" without answering it.
 */

export type ErrorSpec = {
	status: number;
	/** Heading. Short, and true of every reason that lands on it. */
	title: string;
	/** One sentence under the heading. */
	detail: string;
	/** Optional smaller line: what to do next, or what this page deliberately won't say. */
	note?: string;
	/** The id `handleError` logged beside the stack trace, for 500s. */
	reference?: string;
	/** A single link out. Relative, so always same-host. */
	action?: { href: string; label: string };
	/**
	 * Which hostname the page belongs to. `null` renders it unbranded — for requests that
	 * arrived on neither of our hosts, where naming the software is already a hint.
	 */
	brand?: HostKind | null;
	/** Host printed in the footer, when it is ours to print. */
	host?: string;
	headers?: Record<string, string>;
};

/**
 * A top-level document request, as opposed to a sub-resource.
 *
 * `Sec-Fetch-Dest` says so exactly and every current browser sends it; the Accept header
 * is the fallback for clients that do not.
 */
export function isNavigation(request: Request): boolean {
	const dest = request.headers.get('sec-fetch-dest');
	if (dest) return dest === 'document' || dest === 'iframe';
	return (request.headers.get('accept') ?? '').includes('text/html');
}

function wantsJson(request: Request): boolean {
	return (request.headers.get('accept') ?? '').includes('application/json');
}

/**
 * The error, in whichever shape the caller can use.
 *
 * A styled page is only right for a navigation. Answering a `<script src>` or a `fetch()`
 * with HTML puts a document where code was expected: the browser rejects it on the nosniff
 * header and the page breaks with a console message that says nothing about the real
 * cause. Sub-resources get plain text, JSON clients get JSON, and the status — the part
 * every client actually reads — is the same in all three.
 */
export function errorResponse(request: Request, spec: ErrorSpec): Response {
	const headers = new Headers(spec.headers);
	if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
	headers.set('x-content-type-options', 'nosniff');

	let body: string;
	if (isNavigation(request)) {
		headers.set('content-type', 'text/html; charset=utf-8');
		body = renderErrorPage(spec);
	} else if (wantsJson(request)) {
		headers.set('content-type', 'application/json');
		body = JSON.stringify({
			error: spec.title,
			message: spec.detail,
			...(spec.reference ? { id: spec.reference } : {})
		});
	} else {
		headers.set('content-type', 'text/plain; charset=utf-8');
		body = spec.title + '\n';
	}

	// The body is picked from request headers, so a shared cache has to key on them — but
	// only where there is a cache to key. Most callers here send no-store in one spelling
	// or another, and adding a Vary to a response nobody may store only dilutes the
	// `Vary: Cookie` the private-site path sets deliberately. A public site's 404 is the
	// one answer on this path an edge is allowed to keep, and it is the one that gets this.
	if (!(headers.get('cache-control') ?? '').includes('no-store')) {
		headers.append('vary', 'Accept, Sec-Fetch-Dest');
	}

	return new Response(request.method === 'HEAD' ? null : body, { status: spec.status, headers });
}

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ESCAPES[char]);

/**
 * The mark from $lib/components/PageboxMark.svelte, inlined.
 *
 * Duplicated geometry, deliberately: this document is a string built on the server, it
 * cannot import a Svelte component, and it must not reference a file. Same 24×24 lucide
 * grid, painted in `currentColor`, so it follows the theme with no second copy for dark.
 */
const MARK =
	'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
	'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
	'<circle cx="12" cy="6.6" r="4.6"/><g stroke-width="1.295"><path d="M7.4 6.6h9.2"/>' +
	'<path d="M12 2a7 7 0 0 1 1.8 4.6 7 7 0 0 1-1.8 4.6 7 7 0 0 1-1.8-4.6 7 7 0 0 1 1.8-4.6z"/>' +
	'</g><path d="M4.2 11.4 1.4 8.2 5.6 6.2"/><path d="m19.8 11.4 2.8-3.2-4.2-2"/>' +
	'<path d="M4.2 11.4 12 15.6l7.6-4.2"/><path d="M4.2 11.4v6l7.8 4.2 7.6-4.2v-6"/>' +
	'<path d="M12 15.6v6"/></svg>';

/**
 * Palette and type lifted from app.css, cut down to what one page needs.
 *
 * Copied rather than shared because this document is assembled as a string and Tailwind
 * never sees it. They are the panel's own tokens — same greys, same dark theme, same font
 * stacks — so an error reads as part of the console even though it is the one page in the
 * app that is not rendered by it.
 */
const STYLE = [
	':root{color-scheme:light dark;--page:oklch(0.985 0.002 250);--ink:oklch(0.22 0.012 260);--muted:oklch(0.52 0.012 260);--faint:oklch(0.66 0.01 260);--line:oklch(0.22 0.012 260/0.11);--line-soft:oklch(0.22 0.012 260/0.06);--accent:oklch(0.55 0.11 172)}',
	'@media (prefers-color-scheme:dark){:root{--page:oklch(0.19 0.008 260);--ink:oklch(0.93 0.006 260);--muted:oklch(0.7 0.012 260);--faint:oklch(0.58 0.012 260);--line:oklch(1 0 0/0.1);--line-soft:oklch(1 0 0/0.06);--accent:oklch(0.74 0.13 172)}}',
	'*{box-sizing:border-box}',
	"html{background:var(--page);color:var(--ink);font-family:'Inter var','Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}",
	'body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:2rem 1.5rem}',
	'main{width:100%;max-width:26rem}',
	'.mark{display:flex;align-items:center;gap:.5rem;margin-bottom:1.75rem;color:var(--faint)}',
	'.mark b{font-size:.95rem;font-weight:600;letter-spacing:-.01em;color:var(--ink)}',
	'.eyebrow{margin:0;font-size:.6875rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--faint)}',
	'h1{margin:.2rem 0 0;font-size:1.2rem;font-weight:600;letter-spacing:-.015em}',
	'.detail{margin:.45rem 0 0;font-size:.9rem;color:var(--muted)}',
	'.note{margin:.75rem 0 0;font-size:.82rem;color:var(--faint)}',
	".mono,code{font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular','Cascadia Mono',Consolas,monospace;font-size:.86em}",
	'.ref{margin-top:1.4rem;border:1px solid var(--line);border-radius:6px;padding:.75rem}',
	'.ref p{margin:0}',
	'.ref .id{margin-top:.2rem;font-size:.8rem;word-break:break-all}',
	'.ref .hint{margin-top:.3rem;font-size:.78rem;color:var(--faint)}',
	'.act{display:inline-flex;align-items:center;height:2.25rem;margin-top:1.6rem;padding:0 .9rem;border:1px solid var(--line);border-radius:6px;font-size:.875rem;font-weight:500;color:var(--ink);text-decoration:none}',
	'.act:hover{background:var(--line-soft)}',
	'.host{margin:2.25rem 0 0;font-size:.78rem;color:var(--faint)}',
	':focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}',
	'@media (pointer:coarse){.act{height:2.5rem}}'
].join('');

/** The document itself. Exported so the tests can assert on it without a server. */
export function renderErrorPage(spec: ErrorSpec): string {
	const brand = spec.brand ?? null;
	const title = escapeHtml(spec.title);

	const parts = [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1">',
		// An error is never a search result, on either host.
		'<meta name="robots" content="noindex">',
		`<title>${spec.status} — ${title}</title>`,
		`<style>${STYLE}</style>`,
		'</head>',
		'<body>',
		'<main>'
	];

	if (brand) parts.push(`<div class="mark">${MARK}<b>PageBox</b></div>`);
	parts.push(`<p class="eyebrow">${spec.status}</p>`);
	parts.push(`<h1>${title}</h1>`);
	parts.push(`<p class="detail">${escapeHtml(spec.detail)}</p>`);
	if (spec.note) parts.push(`<p class="note">${inlineCode(spec.note)}</p>`);

	if (spec.reference) {
		parts.push(
			'<div class="ref">',
			'<p class="eyebrow">Reference</p>',
			`<p class="id mono">${escapeHtml(spec.reference)}</p>`,
			'<p class="hint">Quote this when reporting it — the server log has the same id.</p>',
			'</div>'
		);
	}

	if (spec.action) {
		parts.push(
			`<a class="act" href="${escapeHtml(spec.action.href)}">${escapeHtml(spec.action.label)}</a>`
		);
	}
	if (spec.host) parts.push(`<p class="host mono">${escapeHtml(spec.host)}</p>`);

	parts.push('</main>', '</body>', '</html>');
	return parts.join('');
}

/**
 * Escapes the note, then re-opens `<code>` around whatever the author wrapped in
 * backticks. The note is the one place a path shape like `/s/<slug>/` is worth showing,
 * and it is always a literal from this repository — never anything a request supplied.
 */
function inlineCode(note: string): string {
	return escapeHtml(note).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * The 404 of this instance — the only one, for every reason either host has to answer it.
 *
 * Called from the host dispatch and from the site server, which between them cover an
 * unknown slug, a suspended site, a site whose deployment was deleted or never activated,
 * a private site the caller has no grant for, a file that is not in the deployment, and a
 * path that is not a site path at all. They share this function so that the wording cannot
 * drift apart later and turn the set of reasons into something a visitor can tell apart.
 *
 * Note that a deployment carrying its own `404.html` never reaches here: serve.ts finds it
 * as a candidate and serves it at status 404, because a site's own not-found page is part
 * of the site (see paths.ts, rule 6).
 */
export function notFoundResponse(
	request: Request,
	kind: HostKind | null,
	headers?: Record<string, string>
): Response {
	if (!kind) {
		// Neither of our hostnames: somebody reached this process by IP, by a stale DNS
		// record, or by pointing a domain at it. They get a real page rather than a line of
		// text, but an unbranded one — which software answered is not their business, and
		// naming it is the hint the host dispatch deliberately withholds.
		return errorResponse(request, {
			status: 404,
			title: 'Not found',
			detail: 'This address is not served here.',
			brand: null,
			headers
		});
	}

	if (kind === 'admin') {
		return errorResponse(request, {
			status: 404,
			title: 'Not found',
			detail: 'This panel has no page at this address.',
			brand: 'admin',
			host: config.PAGEBOX_ADMIN_HOST,
			action: { href: '/', label: 'Start again' },
			headers
		});
	}

	return errorResponse(request, {
		status: 404,
		title: 'Not found',
		detail: 'Nothing is being served at this address.',
		note:
			`Sites live under \`${config.PAGEBOX_SITES_PREFIX}/<slug>/\`. A site that has been ` +
			'taken out of live, one that has not been published yet, and one that never existed ' +
			'all answer exactly this — so if the link worked before, ask whoever gave it to you ' +
			'for a current one. Private sites need a session with access to them.',
		brand: 'sites',
		host: config.PAGEBOX_SITES_HOST,
		action: { href: '/', label: 'Start again' },
		headers
	});
}
