import { describe, expect, it } from 'vitest';
import { errorResponse, notFoundResponse, renderErrorPage } from '../../src/lib/server/errorPage';

/**
 * The error pages served from outside the router. Two properties are worth a test rather
 * than a comment: that the shape a client gets follows what it asked for, and that the
 * 404 stays one answer for every reason it can have.
 */

const req = (headers: Record<string, string> = {}, init: RequestInit = {}) =>
	new Request('http://pages.test/s/whatever/', { headers, ...init });

const navigation = (headers: Record<string, string> = {}) =>
	req({ 'sec-fetch-dest': 'document', ...headers });

describe('errorResponse', () => {
	it('renders a document for a navigation', async () => {
		const res = errorResponse(navigation(), {
			status: 404,
			title: 'Not found',
			detail: 'Nothing here.',
			brand: 'sites'
		});
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
		const body = await res.text();
		expect(body).toContain('<!doctype html>');
		expect(body).toContain('Not found');
		// Styling travels inside the document: an error page that needs a stylesheet is
		// broken exactly when the stylesheet is what broke.
		expect(body).toContain('<style>');
		expect(body).not.toContain('<link');
		expect(body).not.toContain('<script');
	});

	// Answering a <script src> or a fetch() with HTML puts a document where code was
	// expected; the nosniff header then makes the browser reject it with a message that
	// says nothing about the real cause.
	it('answers a sub-resource in plain text', async () => {
		const res = errorResponse(req({ 'sec-fetch-dest': 'script' }), {
			status: 401,
			title: 'Sign in required',
			detail: 'This file belongs to a private site.'
		});
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(await res.text()).toBe('Sign in required\n');
	});

	it('answers a JSON client in JSON', async () => {
		const res = errorResponse(req({ accept: 'application/json' }), {
			status: 404,
			title: 'Not found',
			detail: 'Nothing here.',
			reference: 'abc-123'
		});
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(await res.json()).toEqual({
			error: 'Not found',
			message: 'Nothing here.',
			id: 'abc-123'
		});
	});

	it('sends the status but no body for HEAD', () => {
		const head = errorResponse(new Request('http://pages.test/x', { method: 'HEAD' }), {
			status: 404,
			title: 'Not found',
			detail: 'Nothing here.'
		});
		expect(head.status).toBe(404);
		expect(head.body).toBeNull();
	});

	it('always forbids sniffing, and defaults to no-store', () => {
		const res = errorResponse(navigation(), { status: 403, title: 'Blocked', detail: 'No.' });
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('cache-control')).toBe('no-store');
		// Nothing to vary on: the response is not storable in the first place.
		expect(res.headers.get('vary')).toBeNull();
	});

	// A public site's 404 is the one response here an edge may keep, and its body depends
	// on request headers — so that cache has to key on them.
	it('varies on the negotiation headers when the answer is cacheable', () => {
		const res = errorResponse(navigation(), {
			status: 404,
			title: 'Not found',
			detail: 'Nothing here.',
			headers: { 'cache-control': 'public, no-cache' }
		});
		expect(res.headers.get('vary')?.toLowerCase()).toContain('sec-fetch-dest');
	});
});

describe('renderErrorPage', () => {
	it('escapes everything it prints', () => {
		const html = renderErrorPage({
			status: 500,
			title: 'Something broke',
			detail: 'Bad <input> "value"',
			reference: '<img src=x onerror=alert(1)>'
		});
		expect(html).toContain('Bad &lt;input&gt; &quot;value&quot;');
		expect(html).not.toContain('<img src=x');
	});

	// Backticks in a note are ours, from this repository — never anything a request
	// supplied — so they are the one thing allowed to become markup.
	it('turns backticks in a note into code, and nothing else', () => {
		const html = renderErrorPage({
			status: 404,
			title: 'Not found',
			detail: 'x',
			note: 'Sites live under `/s/<slug>/`.'
		});
		expect(html).toContain('<code>/s/&lt;slug&gt;/</code>');
	});

	it('leaves the mark and the name off an unbranded page', () => {
		const branded = renderErrorPage({
			status: 404,
			title: 'Not found',
			detail: 'x',
			brand: 'sites'
		});
		const bare = renderErrorPage({ status: 404, title: 'Not found', detail: 'x', brand: null });
		expect(branded).toContain('PageBox');
		expect(bare).not.toContain('PageBox');
		expect(bare).not.toContain('<svg');
	});
});

describe('notFoundResponse', () => {
	/**
	 * The invariant the whole not-found path is built on: an unknown slug, a suspended
	 * site, a site with no live deployment and a private site the caller may not see are
	 * one answer, byte for byte. Anything that made them distinguishable would turn the
	 * sites host into an oracle for which private sites exist.
	 */
	it('is one page for every reason a site can be missing', async () => {
		const unknownSlug = await notFoundResponse(navigation(), 'sites').text();
		const takenOffLive = await notFoundResponse(navigation(), 'sites', {
			'cache-control': 'public, no-cache'
		}).text();
		const privateNoGrant = await notFoundResponse(navigation(), 'sites', {
			'cache-control': 'private, no-store',
			vary: 'Cookie'
		}).text();

		expect(takenOffLive).toBe(unknownSlug);
		expect(privateNoGrant).toBe(unknownSlug);
	});

	it('keeps the caching the caller asked for', () => {
		const res = notFoundResponse(navigation(), 'sites', {
			'cache-control': 'private, no-store',
			vary: 'Cookie'
		});
		expect(res.headers.get('cache-control')).toBe('private, no-store');
		expect(res.headers.get('vary')).toBe('Cookie');
	});

	// Reaching this process on a hostname that is neither of ours is not an invitation to
	// say what runs here.
	it('says nothing about the software on a host that is not ours', async () => {
		const body = await notFoundResponse(navigation(), null).text();
		expect(body).not.toContain('PageBox');
		expect(body).not.toContain('/s/');
	});
});
