import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { config } from '../../src/lib/server/config';
import { sameOriginMutation } from '../../src/lib/server/auth/origin';

function mutation(path: string, origin?: string, bearer?: string): RequestEvent {
	const headers = new Headers();
	if (origin) headers.set('origin', origin);
	if (bearer) headers.set('authorization', bearer);
	const url = new URL(`https://${config.PAGEBOX_ADMIN_HOST}${path}`);
	return { url, request: new Request(url, { method: 'POST', headers }) } as RequestEvent;
}

describe('mutation origin', () => {
	const canonical = `${config.PAGEBOX_PUBLIC_SCHEME}://${config.PAGEBOX_ADMIN_HOST}`;
	it('requires the full configured origin for panel actions', () => {
		expect(sameOriginMutation(mutation('/users', canonical), 'admin')).toBe(true);
		const otherScheme = config.PAGEBOX_PUBLIC_SCHEME === 'https' ? 'http' : 'https';
		expect(
			sameOriginMutation(
				mutation('/users', `${otherScheme}://${config.PAGEBOX_ADMIN_HOST}`),
				'admin'
			)
		).toBe(false);
		expect(sameOriginMutation(mutation('/users', `${canonical}:8443`), 'admin')).toBe(false);
		expect(sameOriginMutation(mutation('/users'), 'admin')).toBe(false);
	});
	it('does not let a meaningless Bearer bypass panel CSRF', () => {
		expect(
			sameOriginMutation(mutation('/users', 'https://evil.test', 'Bearer bogus'), 'admin')
		).toBe(false);
	});
	it('allows the token-only API path without an origin', () => {
		expect(
			sameOriginMutation(
				mutation('/api/v1/sites/demo/deployments', undefined, 'Bearer bogus'),
				'admin'
			)
		).toBe(true);
		expect(sameOriginMutation(mutation('/api/v1/sites/demo/deployments'), 'admin')).toBe(false);
	});
});
