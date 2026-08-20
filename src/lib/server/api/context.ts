import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { user } from '../db/schema';
import type { SessionUser } from '../auth';
import { atLeast, permissionFor } from '../perms';
import { lookupSiteBySlug, type SiteRef } from '../sites/resolve';
import { authenticateToken, jsonError, tokenAllowsSite, type TokenAuth } from './auth';

/**
 * Authenticates a deploy token and resolves the site it is acting on.
 *
 * A token scoped to another site gets the same 404 as a slug that does not exist: the API
 * never confirms which sites are there to someone holding the wrong token.
 */
export async function requireSiteToken(
	event: RequestEvent,
	slug: string
): Promise<{ auth: TokenAuth; siteRef: SiteRef } | { response: Response }> {
	const authenticated = await authenticateToken(event);
	if ('error' in authenticated) {
		return { response: jsonError(authenticated.error.status, authenticated.error.message) };
	}

	const siteRef = await lookupSiteBySlug(slug);
	if (!siteRef || siteRef.archived || !tokenAllowsSite(authenticated.auth, siteRef.id)) {
		return { response: jsonError(404, 'site not found') };
	}

	return { auth: authenticated.auth, siteRef };
}

/**
 * The account a token acts as, as it stands *now* — not as it stood when the key was cut.
 *
 * A key is a credential belonging to a person, so it can never outrank them: a token whose
 * owner was banned, demoted or had their grant removed has to stop working, and nothing in
 * the key itself records any of that. Returns null when the owner is gone or suspended.
 */
export async function tokenOwner(auth: TokenAuth): Promise<SessionUser | null> {
	if (!auth.ownerUserId) return null;

	const [row] = await db.select().from(user).where(eq(user.id, auth.ownerUserId)).limit(1);
	if (!row || row.banned) return null;

	return {
		id: row.id,
		email: row.email,
		name: row.name,
		role: row.role ?? 'user',
		banned: Boolean(row.banned),
		mustChangePassword: Boolean(row.mustChangePassword)
	};
}

export function clientIp(event: RequestEvent): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}

export type Caller = {
	kind: 'token' | 'session';
	tokenId: string | null;
	userId: string | null;
	siteRef: SiteRef;
};

/**
 * Two ways into the deploy API, one set of rules.
 *
 * CI sends a bearer token; the panel sends the browser session it already has. They differ
 * only in who is asking — same guards, same limits, same ingestion — because two entry
 * paths would be two sets of guards drifting apart.
 *
 * The cookie path is the one a browser can be tricked into taking, so it is covered by the
 * same-origin check in hooks.server.ts; the bearer path is exempt there and needs no CSRF
 * token of its own.
 */
export async function identifyCaller(
	event: RequestEvent,
	slug: string,
	required: 'deployer' | 'viewer' = 'deployer'
): Promise<{ caller: Caller } | { response: Response }> {
	const hasBearer = event.request.headers.get('authorization')?.toLowerCase().startsWith('bearer ');

	if (hasBearer) {
		const context = await requireSiteToken(event, slug);
		if ('response' in context) return context;

		// The scope on the key says which site; the owner's grants say whether that is still
		// allowed. Both, every call — a key that outlives the permission it was issued under
		// is a permission that cannot be revoked.
		const owner = await tokenOwner(context.auth);
		const permission = owner ? await permissionFor(owner, context.siteRef) : null;
		if (!atLeast(permission, required)) return { response: jsonError(404, 'site not found') };

		return {
			caller: {
				kind: 'token',
				tokenId: context.auth.tokenId,
				userId: context.auth.ownerUserId || null,
				siteRef: context.siteRef
			}
		};
	}

	const user = event.locals.user;
	if (!user) return { response: jsonError(401, 'sign in or send a deploy token') };

	const siteRef = await lookupSiteBySlug(slug);
	if (!siteRef || siteRef.archived) return { response: jsonError(404, 'site not found') };

	// Same answer as a site that does not exist: the API never confirms what is hosted here
	// to someone who may not act on it.
	const permission = await permissionFor(user, siteRef);
	if (!atLeast(permission, required)) return { response: jsonError(404, 'site not found') };

	return { caller: { kind: 'session', tokenId: null, userId: user.id, siteRef } };
}
