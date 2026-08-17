import { describe, expect, it } from 'vitest';
import { parseSitePath } from '../../src/lib/server/sites/resolve';
import { hostKind } from '../../src/lib/server/config';

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
