import { describe, expect, it } from 'vitest';
import { byteRange, matchesIfRange } from '../../src/lib/server/sites/http';

describe('byte ranges', () => {
	it('normalizes bounded, open-ended and suffix ranges', () => {
		expect(byteRange('bytes=0-3', 10)).toBe('bytes=0-3');
		expect(byteRange('bytes=5-', 10)).toBe('bytes=5-9');
		expect(byteRange('bytes=-3', 10)).toBe('bytes=7-9');
		expect(byteRange('bytes=0-100', 10)).toBe('bytes=0-9');
		expect(byteRange('bytes=-100', 10)).toBe('bytes=0-9');
	});
	it('distinguishes unsatisfiable from malformed and unsupported ranges', () => {
		for (const range of ['bytes=10-', 'bytes=-0']) expect(byteRange(range, 10)).toBe(false);
		expect(byteRange('bytes=0-', 0)).toBe(false);
		for (const range of [
			null,
			'items=0-3',
			'bytes=4-1',
			'bytes=-',
			'bytes=0-1,4-5',
			'bytes=9007199254740992-'
		])
			expect(byteRange(range, 10)).toBeNull();
	});
});

describe('If-Range', () => {
	const head = { size: 10, etag: '"current"', lastModified: new Date('2026-10-01T12:00:00.123Z') };
	it('requires an exact strong entity tag', () => {
		expect(matchesIfRange(null, head)).toBe(true);
		expect(matchesIfRange('"current"', head)).toBe(true);
		expect(matchesIfRange('W/"current"', head)).toBe(false);
		expect(matchesIfRange('"previous"', head)).toBe(false);
	});
	it('requires a matching modification date at HTTP second precision', () => {
		expect(matchesIfRange('Thu, 01 Oct 2026 12:00:00 GMT', head)).toBe(true);
		expect(matchesIfRange('Thu, 01 Oct 2026 12:00:01 GMT', head)).toBe(false);
		expect(matchesIfRange('invalid', head)).toBe(false);
		expect(matchesIfRange('Thu, 01 Oct 2026 12:00:00 GMT', { size: 10 })).toBe(false);
	});
});
