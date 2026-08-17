import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '../db';
import { deployToken } from '../db/schema';
import { hashToken, TOKEN_PREFIX } from '../ids';

/**
 * Bearer authentication for the deploy API.
 *
 * Tokens are stored as sha256 only, so the lookup is by hash — there is nothing to leak
 * from the table and nothing to compare in constant time beyond the hash itself.
 */

export type TokenAuth = {
	tokenId: string;
	/** null = the token may deploy to any site. */
	siteId: string | null;
	createdByUserId: string | null;
};

export type AuthFailure = { status: 401 | 403; message: string };

export async function authenticateToken(
	event: RequestEvent
): Promise<{ auth: TokenAuth } | { error: AuthFailure }> {
	const header = event.request.headers.get('authorization');
	if (!header?.toLowerCase().startsWith('bearer ')) {
		return { error: { status: 401, message: 'missing bearer token' } };
	}

	const token = header.slice(7).trim();
	if (!token.startsWith(TOKEN_PREFIX)) {
		return { error: { status: 401, message: 'invalid token' } };
	}

	const now = new Date();
	const [row] = await db
		.select()
		.from(deployToken)
		.where(
			and(
				eq(deployToken.tokenHash, hashToken(token)),
				isNull(deployToken.revokedAt),
				or(isNull(deployToken.expiresAt), gt(deployToken.expiresAt, now))
			)
		)
		.limit(1);

	if (!row) return { error: { status: 401, message: 'invalid token' } };

	// Best-effort: a failed touch must not fail the deploy.
	db.update(deployToken)
		.set({ lastUsedAt: now })
		.where(eq(deployToken.id, row.id))
		.catch((err: unknown) => console.error('[pagebox] token touch failed:', err));

	return {
		auth: { tokenId: row.id, siteId: row.siteId, createdByUserId: row.createdByUserId }
	};
}

/** A token scoped to one site may not touch another. */
export function tokenAllowsSite(auth: TokenAuth, siteId: string): boolean {
	return auth.siteId === null || auth.siteId === siteId;
}

export function jsonError(status: number, message: string, extra: Record<string, unknown> = {}) {
	return new Response(JSON.stringify({ error: message, ...extra }), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

export function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}
