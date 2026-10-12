import type { ObjectHead } from '../s3';

/** Weak comparison is sufficient for If-None-Match on GET and HEAD. */
export function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
	if (!ifNoneMatch) return false;
	if (ifNoneMatch.trim() === '*') return true;
	const normalise = (value: string) => value.trim().replace(/^W\//, '');
	return ifNoneMatch.split(',').some((value) => normalise(value) === normalise(etag));
}

export function matchesIfRange(value: string | null, head: ObjectHead): boolean {
	if (value === null) return true;
	const validator = value.trim();
	if (validator.startsWith('W/')) return false;
	if (validator.startsWith('"')) return validator === head.etag;
	const date = Date.parse(validator);
	return (
		Number.isFinite(date) &&
		Boolean(head.lastModified) &&
		Math.floor(head.lastModified!.getTime() / 1000) === Math.floor(date / 1000)
	);
}

/** Ignore unsupported/malformed ranges; false denotes a valid but unsatisfiable range. */
export function byteRange(value: string | null, size: number): string | null | false {
	if (!value) return null;
	const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
	if (!match || (!match[1] && !match[2])) return null;
	const start = match[1] ? Number(match[1]) : null;
	const end = match[2] ? Number(match[2]) : null;
	if (
		(start !== null && !Number.isSafeInteger(start)) ||
		(end !== null && !Number.isSafeInteger(end))
	)
		return null;
	if (start !== null && end !== null && start > end) return null;
	if (size === 0 || (start !== null && start >= size) || (start === null && end === 0))
		return false;
	const first = start ?? Math.max(0, size - end!);
	const last = start === null || end === null ? size - 1 : Math.min(end, size - 1);
	return `bytes=${first}-${last}`;
}
