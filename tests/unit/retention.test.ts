import { describe, expect, it } from 'vitest';
import {
	MAX_RETENTION,
	MIN_RETENTION,
	parseRetention
} from '../../src/lib/server/deploy/retention';

/**
 * The retention field deletes builds, so what it accepts is worth pinning down: the two
 * ways of saying "keep everything" have to stay equivalent, and a limit low enough to
 * leave nothing to roll back to has to be refused rather than quietly applied.
 */
describe('parseRetention', () => {
	it('treats an empty field and zero as "keep everything"', () => {
		expect(parseRetention('')).toEqual({ value: null });
		expect(parseRetention(null)).toEqual({ value: null });
		expect(parseRetention('   ')).toEqual({ value: null });
		expect(parseRetention('0')).toEqual({ value: null });
	});

	it('accepts a whole number inside the range', () => {
		expect(parseRetention(String(MIN_RETENTION))).toEqual({ value: MIN_RETENTION });
		expect(parseRetention('10')).toEqual({ value: 10 });
		expect(parseRetention(String(MAX_RETENTION))).toEqual({ value: MAX_RETENTION });
		expect(parseRetention(' 7 ')).toEqual({ value: 7 });
	});

	// Keeping one deployment means the live one and nothing else: the next deploy would
	// leave no previous build to go back to, which is the opposite of what history is for.
	it('refuses a limit that leaves nothing to roll back to', () => {
		const parsed = parseRetention(String(MIN_RETENTION - 1));
		expect(parsed.value).toBeNull();
		expect(parsed.error).toMatch(/at least/);
	});

	it('refuses anything that is not a whole positive count', () => {
		expect(parseRetention('-3').error).toBeTruthy();
		expect(parseRetention('2.5').error).toBeTruthy();
		expect(parseRetention('all').error).toBeTruthy();
		expect(parseRetention(String(MAX_RETENTION + 1)).error).toBeTruthy();
	});
});
