import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { withStorageLock } from '../db/locks';
import { loadSession } from './session';

/** Recheck the session after waiting; a reset or role change may have happened in the queue. */
export function panelMutation<T>(event: RequestEvent, fn: () => Promise<T>): Promise<T> {
	return withStorageLock(async () => {
		event.locals.user = await loadSession(event, 'admin', {
			allowIncompleteTwoFactor: event.url.pathname === '/account/password'
		});
		if (!event.locals.user) error(401, 'Sign in required');
		if (event.locals.user.twoFactorEnabled && !event.locals.twoFactorVerified)
			error(403, 'Verify two-factor authentication before continuing');
		if (event.locals.user.mustChangePassword && event.url.pathname !== '/account/password') {
			error(403, 'Change your password before continuing');
		}
		return fn();
	});
}
