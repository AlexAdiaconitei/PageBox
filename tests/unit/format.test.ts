import { describe, expect, it } from 'vitest';
import { formatBytes, formatSizeInput, parseSize } from '../../src/lib/format';

/**
 * `formatSizeInput` writes a byte count back into a field somebody is about to edit, so the
 * property that matters is not how it reads but that it round-trips: whatever it prints,
 * `parseSize` has to give back the exact number it was handed. A pre-filled field that
 * rounds changes the stored value of every row whose owner opens it and presses Set.
 */
describe('formatSizeInput', () => {
	it('picks the largest unit that divides exactly', () => {
		expect(formatSizeInput(200 * 1024 ** 2)).toBe('200MB');
		expect(formatSizeInput(1024 ** 3)).toBe('1GB');
		expect(formatSizeInput(1536 * 1024 ** 2)).toBe('1.5GB');
		expect(formatSizeInput(2 * 1024 ** 4)).toBe('2TB');
		expect(formatSizeInput(512 * 1024)).toBe('512KB');
	});

	it('falls back to plain bytes rather than rounding', () => {
		expect(formatSizeInput(1234567)).toBe('1234567');
		expect(parseSize(formatSizeInput(1234567))).toBe(1234567);
	});

	it('round-trips through parseSize', () => {
		for (const bytes of [0, 1024, 10 * 1024 ** 2, 1024 ** 3 + 1, 5 * 1024 ** 3, 7654321]) {
			expect(parseSize(formatSizeInput(bytes))).toBe(bytes);
		}
	});

	it('is empty for no quota, and 0 for a quota of nothing', () => {
		expect(formatSizeInput(null)).toBe('');
		expect(formatSizeInput(0)).toBe('0');
	});

	// The reading format is the lossy one, on purpose — it is for a column, not a field.
	it('is not formatBytes', () => {
		expect(formatBytes(1234567)).toBe('1.2 MB');
	});
});
