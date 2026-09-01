import { describe, expect, it } from 'vitest';
import { GIB, MIB, parseQuota } from '../../src/lib/server/quota';

/**
 * The quota field takes the same sizes as `PAGEBOX_STORAGE_BYTES` — `200MB`, `1.5GB`, or a
 * plain number of bytes — and it is the number that decides whether somebody can deploy, so
 * what it accepts is worth pinning down. Zero is a real, deliberate value here (an admin who
 * may hold nothing), which is the opposite of how the retention field treats it, hence the
 * explicit cases.
 */
describe('parseQuota', () => {
	it('takes a size with a unit', () => {
		expect(parseQuota('200MB')).toEqual({ value: 200 * MIB });
		expect(parseQuota('200mb')).toEqual({ value: 200 * MIB });
		expect(parseQuota('500 MB')).toEqual({ value: 500 * MIB });
		expect(parseQuota('1.5GB')).toEqual({ value: 1.5 * GIB });
		expect(parseQuota(' 2TB ')).toEqual({ value: 2 * 1024 ** 4 });
	});

	// The same reading as the environment: a bare figure is bytes, and `GB` and `GiB` are
	// the same 1024-based unit, so the panel prints back what was typed.
	it('reads a bare number as bytes, and GiB as GB', () => {
		expect(parseQuota('5368709120')).toEqual({ value: 5 * GIB });
		expect(parseQuota('1GiB')).toEqual(parseQuota('1GB'));
	});

	// Not "unlimited": an admin set to zero holds nothing, which is how you stop somebody
	// storing anything more without taking away what they have.
	it('treats zero as a real quota of nothing', () => {
		expect(parseQuota('0')).toEqual({ value: 0 });
	});

	it('treats an empty field as unset', () => {
		expect(parseQuota('')).toEqual({ value: null });
		expect(parseQuota(null)).toEqual({ value: null });
		expect(parseQuota('   ')).toEqual({ value: null });
	});

	// A figure this small cannot hold one build of anything, so it is far more likely a
	// typo — or a bare `5` meant as gigabytes — than an intention.
	it('refuses a figure too small to hold a build', () => {
		expect(parseQuota('5').error).toBeTruthy();
		expect(parseQuota('1023').error).toBeTruthy();
		expect(parseQuota('0.0001MB').error).toBeTruthy();
		expect(parseQuota('1MB')).toEqual({ value: MIB });
	});

	it('refuses anything that is not a size', () => {
		expect(parseQuota('-5GB').error).toBeTruthy();
		expect(parseQuota('lots').error).toBeTruthy();
		expect(parseQuota('Infinity').error).toBeTruthy();
		expect(parseQuota('1 gigabyte').error).toBeTruthy();
		expect(parseQuota('1,5GB').error).toBeTruthy();
		// The near-miss the environment parser also refuses: taking the digits off the front
		// of a typo is how a quota ends up an order of magnitude out.
		expect(parseQuota('500MB free').error).toBeTruthy();
	});

	it('rounds to whole bytes', () => {
		const parsed = parseQuota('0.333GB');
		expect(Number.isInteger(parsed.value)).toBe(true);
	});
});
