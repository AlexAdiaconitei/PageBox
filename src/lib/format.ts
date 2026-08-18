/**
 * Display formatting shared by the panel screens.
 *
 * These are read-at-a-glance formats, not exact ones: sizes round to one decimal and ages
 * round to whole units, because the operator is scanning a column, not auditing a figure.
 * Anything exact — the full ULID, the precise timestamp — stays in the row's `title`.
 */

export function formatBytes(n: number): string {
	const units = ['B', 'KB', 'MB', 'GB'];
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
