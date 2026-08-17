import type { RequestEvent } from '@sveltejs/kit';
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
