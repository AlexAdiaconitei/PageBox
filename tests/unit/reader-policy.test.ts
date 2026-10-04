import { describe, expect, it } from 'vitest';
import { getCookies } from 'better-auth/cookies';
import { cookiePolicy } from '../../src/lib/server/auth/index';
import {
	safeLoginDestination,
	safeReaderDestination
} from '../../src/lib/server/auth/destinations';

describe('reader cookie policy', () => {
	for (const kind of ['admin', 'sites'] as const) {
		it('uses browser-enforced host cookies over HTTPS for ' + kind, () => {
			const cookies = getCookies({
				baseURL: 'https://login.example.com',
				advanced: cookiePolicy(kind, 'https')
			});
			const expected = kind === 'admin' ? '__Host-pb_admin.' : '__Host-pb_view.';
			for (const cookie of Object.values(cookies)) {
				expect(cookie.name.startsWith(expected)).toBe(true);
				expect(cookie.name.startsWith('__Secure-')).toBe(false);
				expect(cookie.attributes).toMatchObject({ secure: true, path: '/', httpOnly: true });
				expect(cookie.attributes.domain).toBeUndefined();
			}
		});
		it('allows explicit HTTP development without invalid secure prefixes for ' + kind, () => {
			const cookies = getCookies({
				baseURL: 'http://login.localhost',
				advanced: cookiePolicy(kind, 'http')
			});
			expect(cookies.sessionToken.name).toBe(
				kind === 'admin' ? 'pb_admin.session_token' : 'pb_view.session_token'
			);
			expect(cookies.sessionToken.attributes.secure).toBe(false);
			expect(cookies.sessionToken.attributes.domain).toBeUndefined();
		});
	}
});

describe('safe login destinations', () => {
	it('preserves the authorization query after a central reader login', () => {
		expect(safeLoginDestination('/access?site=private&next=%2Fs%2Fprivate%2F', 'sites', '/s')).toBe(
			'/access?site=private&next=%2Fs%2Fprivate%2F'
		);
	});
	it('allows panel paths only on the panel host', () => {
		expect(safeLoginDestination('/users', 'sites', '/s')).toBe('/');
		expect(safeLoginDestination('/users', 'admin', '/s')).toBe('/users');
	});
	for (const path of [
		'https://evil.test',
		'//evil.test',
		'/\\evil.test',
		'/foo\\bar',
		'/%2f%2fevil.test',
		'/%5cevil.test',
		'/%250ae',
		'/bad%0a',
		'/bad%00',
		'/bad%zz',
		'/accessory',
		'/access/child'
	]) {
		it('rejects unsafe reader destination ' + JSON.stringify(path), () => {
			expect(safeLoginDestination(path, 'sites', '/s')).toBe('/');
		});
	}
});

describe('safe site destinations', () => {
	const address = { origin: 'https://demo-id.pages.example.com', basePath: '/s/demo/' };
	it('keeps encoded spaces, Unicode and query parameters within this site', () => {
		expect(safeReaderDestination('/s/demo/caf%C3%A9%20file.txt?q=a', address)).toBe(
			'/s/demo/caf%C3%A9%20file.txt?q=a'
		);
	});
	it('normalizes the root slash after authorization', () => {
		expect(safeReaderDestination('/s/demo?q=keep', address)).toBe('/s/demo/?q=keep');
	});
	for (const path of [
		'//evil.test/s/demo/',
		'/s/other/',
		'/s/demo/../other/',
		'/s/demo/%2e%2e/other/',
		'/s/demo/%252e%252e/other/',
		'/s/demo/%2fsecret',
		'/s/demo/%5csecret',
		'/s/demo/.env',
		'/s/demo/.git/config',
		'/s/demo/__pb/accept',
		'/s/demo/bad%0a',
		'/s/demo/bad%zz'
	]) {
		it('rejects authorization redirect ' + JSON.stringify(path), () => {
			expect(safeReaderDestination(path, address)).toBe('/s/demo/');
		});
	}
});
