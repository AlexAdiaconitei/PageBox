import { describe, expect, it } from 'vitest';
import { GIB, parseQuota } from '../../src/lib/server/quota';

/**
 * The quota field is entered in gigabytes and stored in bytes, and it is the number that
 * decides whether somebody can deploy — so what it accepts is worth pinning down. Zero is
 * a real, deliberate value here (an admin who may hold nothing), which is the opposite of
 * how the retention field treats it, hence the explicit cases.
 */
describe('parseQuota', () => {
	it('converts gigabytes to bytes', () => {
		expect(parseQuota('5')).toEqual({ value: 5 * GIB });
		expect(parseQuota('0.5')).toEqual({ value: 0.5 * GIB });
		expect(parseQuota(' 100 ')).toEqual({ value: 100 * GIB });
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
	// typo — 0.0001 for 1 — than an intention.
	it('refuses a figure too small to hold a build', () => {
		expect(parseQuota('0.0000001').error).toBeTruthy();
	});

	it('refuses anything that is not a positive number', () => {
		expect(parseQuota('-5').error).toBeTruthy();
		expect(parseQuota('lots').error).toBeTruthy();
		expect(parseQuota('Infinity').error).toBeTruthy();
	});

	it('rounds to whole bytes', () => {
		const parsed = parseQuota('0.333');
		expect(Number.isInteger(parsed.value)).toBe(true);
	});
});
