import { ulid } from 'ulidx';

/** ULIDs everywhere: sortable by creation time, safe in URLs and S3 keys. */
export const newId = (): string => ulid();

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function isValidSlug(slug: string): boolean {
	return SLUG_RE.test(slug);
}

/**
 * Deploy tokens carry this prefix so a leaked string is recognisable as one.
 *
 * Generation and hashing used to live here too; `@better-auth/api-key` owns both now, and
 * keeping a second implementation around invited someone to call the one that no longer
 * decides anything.
 */
export const TOKEN_PREFIX = 'pbx_';
