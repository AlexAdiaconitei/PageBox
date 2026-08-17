import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authFor } from '$lib/server/auth';
import { audit } from '$lib/server/audit';

/** POST only: a logout reachable by GET is a logout any page can trigger with an <img>. */
export const POST: RequestHandler = async (event) => {
	if (event.locals.user) {
		await authFor(event.locals.hostKind).api.signOut({ headers: event.request.headers });
		await audit({
			action: 'logout',
			actorUserId: event.locals.user.id,
			meta: { host: event.locals.hostKind }
		});
	}
	redirect(303, '/login');
};
