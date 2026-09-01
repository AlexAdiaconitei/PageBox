/**
 * Display formatting shared by the panel screens.
 *
 * These are read-at-a-glance formats, not exact ones: sizes round to one decimal and ages
 * round to whole units, because the operator is scanning a column, not auditing a figure.
 * Anything exact — the full ULID, the precise timestamp — stays in the row's `title`.
 */

export function formatBytes(n: number): string {
	// Through PB, because the last unit is not a ceiling on the number — it is a ceiling on
	// the *label*, and a fleet of a few terabytes rendered as "4096.0 GB" reads as a bug.
	const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
	let value = n;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${Math.round(value * 10) / 10} ${units[unit]}`;
}

/**
 * "3h ago", "2d ago". An absolute timestamp answers "when exactly"; on a dashboard the
 * question is "how stale", and a relative age answers it without arithmetic.
 */
export function timeAgo(value: string | Date | null): string {
	if (!value) return '—';
	const then = new Date(value).getTime();
	if (Number.isNaN(then)) return '—';

	// Every step goes through Intl, including the first: a hardcoded "just now" would be the
	// one English word in a column the browser otherwise renders in the reader's language.
	const seconds = Math.round((Date.now() - then) / 1000);
	const steps: [limit: number, per: number, unit: Intl.RelativeTimeFormatUnit][] = [
		[60, 1, 'second'],
		[3600, 60, 'minute'],
		[86400, 3600, 'hour'],
		[2592000, 86400, 'day'],
		[31536000, 2592000, 'month'],
		[Infinity, 31536000, 'year']
	];
	const [, per, unit] = steps.find(([limit]) => seconds < limit)!;
	return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' }).format(
		-Math.round(seconds / per),
		unit
	);
}

/** The long form, for the cells and tooltips where the exact moment is the point. */
export function fullDate(value: string | Date | null): string {
	return value
		? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
		: '—';
}

/**
 * Sizes are written the way people say them out loud: `1GB`, `1gb`, `500MB`, `1.5 GB`. A
 * plain number is still a number of bytes, so every configuration written before this
 * parses to exactly what it did.
 *
 * The units are binary — `1GB` is 1073741824, and `GB` and `GiB` mean the same thing. That
 * is the unfashionable reading, and it is the one that round-trips: `formatBytes` divides by
 * 1024 and prints `GB`, so a decimal `GB` here would mean the panel answers `931.3 GB` to
 * somebody who typed `1TB`, which reads as a bug in the arithmetic rather than a difference
 * of opinion about SI prefixes.
 *
 * Fractions are allowed and round to the nearest byte: `0.5GB` is a reasonable quota, and
 * nobody should have to multiply it out by hand.
 *
 * This lives in `$lib/format` rather than beside the config schema because the panel enters
 * sizes too — a storage quota is the same small language as `PAGEBOX_STORAGE_BYTES`, and
 * two parsers for one syntax is how `500MB` comes to mean different things on two screens.
 */
const SIZE_UNITS: Record<string, number> = {
	'': 1,
	b: 1,
	k: 1024,
	kb: 1024,
	kib: 1024,
	m: 1024 ** 2,
	mb: 1024 ** 2,
	mib: 1024 ** 2,
	g: 1024 ** 3,
	gb: 1024 ** 3,
	gib: 1024 ** 3,
	t: 1024 ** 4,
	tb: 1024 ** 4,
	tib: 1024 ** 4,
	p: 1024 ** 5,
	pb: 1024 ** 5,
	pib: 1024 ** 5
};

export const SIZE_HINT =
	'must be a size like 500MB, 1.5GB or 1073741824 (plain numbers are bytes; ' +
	'KB/MB/GB/TB are 1024-based, and KiB/MiB/GiB mean the same)';

/**
 * `null` for anything that is not a size — including the near-misses that would otherwise
 * be read as something smaller than intended. `100 MB free` is not 100 MB, and quietly
 * taking the digits off the front of a typo is how a cap ends up an order of magnitude off.
 */
export function parseSize(raw: unknown): number | null {
	const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(String(raw ?? '').trim());
	if (!match) return null;
	const unit = SIZE_UNITS[match[2].toLowerCase()];
	if (unit === undefined) return null;
	const value = Number(match[1]) * unit;
	return Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * The same figure, written back into a field somebody is about to edit.
 *
 * Not `formatBytes`: that rounds to one decimal for reading at a glance, and a form
 * pre-filled with a rounded figure silently *changes* the value of every row whose owner
 * opens the field and presses Set. This picks the largest unit the byte count divides into
 * exactly, so it always parses back to the number it came from, and falls back to plain
 * bytes when nothing divides evenly.
 */
export function formatSizeInput(bytes: number | null): string {
	if (bytes === null) return '';
	if (bytes === 0) return '0';
	const units: [label: string, size: number][] = [
		['TB', 1024 ** 4],
		['GB', 1024 ** 3],
		['MB', 1024 ** 2],
		['KB', 1024]
	];
	for (const [label, size] of units) {
		const value: number = bytes / size;
		// At most three decimals, and the multiplication back has to land on the same byte:
		// `1.5GB` is worth printing, `1205.632KB` is a rounded figure wearing a unit.
		if (value >= 1 && Number.isInteger(value * 1000) && value * size === bytes) {
			return `${value}${label}`;
		}
	}
	return String(bytes);
}
