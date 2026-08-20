import type { RequestEvent } from '@sveltejs/kit';
import { adminAuth } from '../auth';
import { TOKEN_PREFIX } from '../ids';

/**
 * Bearer authentication for the deploy API, backed by the `@better-auth/api-key` plugin.
 *
 * Verification is one call: the plugin checks the hash, whether the key is enabled, its
 * expiry and its own rate limit, and records the request. Nothing about key storage or
 * throttling is reimplemented here — the only PageBox-specific part is which site a key
 * may deploy to, which lives in its metadata.
 */

export type TokenAuth = {
	tokenId: string;
	/**
	 * The one site this token may act on. Null means the key carries no PageBox scope —
	 * every key the panel issues has one, so a key without it was created by something
	 * else, and "something else" is not a set of sites we can name.
	 */
	siteId: string | null;
	ownerUserId: string;
};

export type AuthFailure = { status: 401 | 429; message: string };

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

	const result = await adminAuth.api.verifyApiKey({ body: { key: token } });
	if (!result.valid || !result.key) {
		// The plugin distinguishes an unknown key from one that has been used too often;
		// everything else collapses into the same answer.
		const code = result.error?.code;
		return code === 'RATE_LIMITED' || code === 'RATE_LIMIT_EXCEEDED'
			? { error: { status: 429, message: 'too many requests for this token' } }
			: { error: { status: 401, message: 'invalid token' } };
	}

	return {
		auth: {
			tokenId: result.key.id,
			siteId: siteIdOf(result.key.metadata),
			ownerUserId: result.key.referenceId ?? ''
		}
	};
}

/** Metadata comes back parsed or as a JSON string depending on the storage path. */
function siteIdOf(metadata: unknown): string | null {
	if (!metadata) return null;
	const parsed = typeof metadata === 'string' ? safeParse(metadata) : metadata;
	const siteId = (parsed as { siteId?: unknown } | null)?.siteId;
	return typeof siteId === 'string' && siteId.length > 0 ? siteId : null;
}

function safeParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

/**
 * A token may act on exactly the site it was issued for.
 *
 * An unscoped key used to mean "any site its owner can reach", which is a wildcard nobody
 * asked for: the panel is the only thing that issues keys and it always sets the scope, so
 * the only key that can reach this branch is one created outside PageBox. Default-deny.
 */
export function tokenAllowsSite(auth: TokenAuth, siteId: string): boolean {
	return auth.siteId !== null && auth.siteId === siteId;
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
