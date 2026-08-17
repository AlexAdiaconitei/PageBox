import type { RequestEvent } from '@sveltejs/kit';
import type { HostKind } from '../config';
import { audit } from '../audit';
import { authFor, scopeFor, type SessionUser } from './index';

/**
 * Reads the session for the host the request arrived on, and refuses anything that does
 * not belong there.
 *
 * The scope check is the point: a `view` session presented on the admin host (or the
 * reverse) is treated as no session at all and logged, because the only way for that to
 * happen is someone moving a cookie value across the host boundary on purpose.
 */
export async function loadSession(
	event: RequestEvent,
	kind: HostKind
): Promise<SessionUser | null> {
	const auth = authFor(kind);
	const result = await auth.api.getSession({ headers: event.request.headers });
	if (!result?.user || !result.session) return null;

	const scope = (result.session as { scope?: string }).scope ?? 'admin';
	if (scope !== scopeFor(kind)) {
		await audit({
			action: 'session.scope_mismatch',
			actorUserId: result.user.id,
			targetType: 'session',
			targetId: result.session.id,
			meta: { sessionScope: scope, host: kind },
			ip: event.request.headers.get('x-forwarded-for')
		});
		return null;
	}

	const user = result.user as unknown as SessionUser;
	// A banned user keeps a valid cookie until it expires; the ban has to bite here.
	if (user.banned) return null;

	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role ?? 'user',
		banned: Boolean(user.banned),
		mustChangePassword: Boolean(user.mustChangePassword)
	};
}
