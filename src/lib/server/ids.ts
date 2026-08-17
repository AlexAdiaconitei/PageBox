import { ulid } from 'ulidx';
import { randomBytes, createHash } from 'node:crypto';

/** ULIDs everywhere: sortable by creation time, safe in URLs and S3 keys. */
export const newId = (): string => ulid();

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function isValidSlug(slug: string): boolean {
	return SLUG_RE.test(slug);
}

export const TOKEN_PREFIX = 'pbx_';

/** Deploy token: shown once, stored only as sha256. `prefix` identifies it in the UI. */
export function newDeployToken(): { token: string; hash: string; prefix: string } {
	const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
	return { token, hash: hashToken(token), prefix: token.slice(0, TOKEN_PREFIX.length + 8) };
}

export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}
