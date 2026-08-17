import type { RequestEvent } from '@sveltejs/kit';
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
