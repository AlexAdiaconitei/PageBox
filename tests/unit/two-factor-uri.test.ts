import { describe, expect, it } from 'vitest';
import { authenticatorUri } from '../../src/lib/server/auth/two-factor';
import { adminUrl } from '../../src/lib/server/config';

describe('authenticator branding', () => {
	it('adds the canonical PageBox icon without changing the TOTP identity or parameters', () => {
		const original = new URL(
			'otpauth://totp/PageBox:user%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=PageBox&digits=6&period=30&algorithm=SHA1'
		);
		const branded = new URL(authenticatorUri(original.href));
		expect(branded.protocol).toBe(original.protocol);
		expect(branded.host).toBe(original.host);
		expect(branded.pathname).toBe(original.pathname);
		for (const [name, value] of original.searchParams)
			expect(branded.searchParams.get(name)).toBe(value);
		expect(branded.searchParams.get('image')).toBe(adminUrl('/icon-192.png'));
	});
});
