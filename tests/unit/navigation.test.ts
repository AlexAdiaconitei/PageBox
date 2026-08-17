import { describe, expect, it } from 'vitest';
import { isNavigation } from '../../src/lib/server/sites/serve';

const req = (headers: Record<string, string>) => new Request('http://x/', { headers });

describe('isNavigation', () => {
	it('trusts Sec-Fetch-Dest when the browser sends it', () => {
		expect(isNavigation(req({ 'sec-fetch-dest': 'document' }))).toBe(true);
		expect(isNavigation(req({ 'sec-fetch-dest': 'iframe' }))).toBe(true);
		expect(isNavigation(req({ 'sec-fetch-dest': 'script' }))).toBe(false);
		expect(isNavigation(req({ 'sec-fetch-dest': 'style' }))).toBe(false);
		expect(isNavigation(req({ 'sec-fetch-dest': 'empty' }))).toBe(false);
	});

	// A stylesheet request carrying a broad Accept must not be mistaken for a navigation:
	// Sec-Fetch-Dest wins even when Accept says text/html.
	it('prefers Sec-Fetch-Dest over Accept', () => {
		expect(isNavigation(req({ 'sec-fetch-dest': 'style', accept: 'text/html,*/*' }))).toBe(false);
	});

	it('falls back to Accept for clients without Sec-Fetch-Dest', () => {
		expect(isNavigation(req({ accept: 'text/html,application/xhtml+xml' }))).toBe(true);
		expect(isNavigation(req({ accept: 'text/css,*/*;q=0.1' }))).toBe(false);
		expect(isNavigation(req({}))).toBe(false);
	});
});
