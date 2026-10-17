import { describe, expect, it } from 'vitest';
import { parseSitePath } from '../../src/lib/server/sites/resolve';
import { hostKind, normaliseSiteDomain } from '../../src/lib/server/config';

describe('parseSitePath', () => {
	it('parses a site root with trailing slash', () => {
		expect(parseSitePath('/s/docs-a/')).toEqual({
			slug: 'docs-a',
			subpath: '',
			needsTrailingSlashRedirect: false
		});
	});

	// Without the redirect every relative URL in the HTML resolves one level too high.
	it('flags a missing trailing slash', () => {
		expect(parseSitePath('/s/docs-a')).toEqual({
			slug: 'docs-a',
			subpath: '',
			needsTrailingSlashRedirect: true
		});
	});

	it('parses nested subpaths', () => {
		expect(parseSitePath('/s/docs-a/guide/intro.html')?.subpath).toBe('guide/intro.html');
		expect(parseSitePath('/s/docs-a/_next/static/x.js')?.subpath).toBe('_next/static/x.js');
	});

	it('rejects paths outside the site prefix', () => {
		expect(parseSitePath('/')).toBeNull();
		expect(parseSitePath('/healthz')).toBeNull();
		expect(parseSitePath('/api/v1/whoami')).toBeNull();
		expect(parseSitePath('/sx/docs-a/')).toBeNull();
	});

	it('rejects invalid slugs', () => {
		expect(parseSitePath('/s//')).toBeNull();
		expect(parseSitePath('/s/-bad/')).toBeNull();
		expect(parseSitePath('/s/UPPER/')).toBeNull();
		expect(parseSitePath('/s/a/')).toBeNull(); // one char: below the 2-41 range
		expect(parseSitePath(`/s/${'a'.repeat(42)}/`)).toBeNull();
	});
});

describe('hostKind', () => {
	it('maps each configured host and nothing else', () => {
		expect(hostKind('pagebox.test')).toBe('admin');
		expect(hostKind('pages.test')).toBe('sites');
		expect(hostKind('PAGES.test')).toBe('sites');
		expect(hostKind('pages.test:5173')).toBe('sites');
		expect(hostKind('evil.example.com')).toBeNull();
		expect(hostKind('')).toBeNull();
	});
});

describe('normaliseSiteDomain', () => {
	const host = (input: string) => {
		const result = normaliseSiteDomain(input);
		return 'hostname' in result ? result.hostname : null;
	};

	it('stores one spelling per domain', () => {
		expect(host('Docs.Example.com')).toBe('docs.example.com');
		expect(host(' docs.example.com. ')).toBe('docs.example.com');
		expect(host('bücher.example')).toBe('xn--bcher-kva.example');
		expect(host('docs.localhost:5173')).toBe('docs.localhost:5173');
	});

	it('takes a domain, not a URL', () => {
		expect(host('https://docs.example.com')).toBeNull();
		expect(host('docs.example.com/guide')).toBeNull();
		expect(host('user@docs.example.com')).toBeNull();
		expect(host('*.example.com')).toBeNull();
		expect(host('localhost')).toBeNull();
		expect(host('10.0.0.1')).toBeNull();
		expect(host('docs.example.com:0')).toBeNull();
		expect(host('')).toBeNull();
	});

	// Uploaded content must never share an origin with, or sit under, PageBox's own hosts.
	it('refuses the instance hosts', () => {
		expect(host('pagebox.test')).toBeNull();
		expect(host('evil.pagebox.test')).toBeNull();
		expect(host('pages.test')).toBeNull();
		expect(host('docs.pages.test')).toBe('docs.pages.test');
	});
});
