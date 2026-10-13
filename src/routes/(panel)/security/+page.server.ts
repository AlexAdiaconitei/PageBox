import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { isSuperadmin } from '$lib/server/auth';
import { panelMutation } from '$lib/server/auth/mutation';
import { isTwoFactorRequired } from '$lib/server/auth/two-factor';
import { db } from '$lib/server/db';
import { securityPolicy } from '$lib/server/db/schema';
import { audit } from '$lib/server/audit';

export const load: PageServerLoad = async ({ locals }) => {
	if (!isSuperadmin(locals.user)) error(404, 'Not found');
	return {
		required: await isTwoFactorRequired(),
		canRequire: locals.user!.twoFactorEnabled && locals.twoFactorVerified
	};
};

export const actions: Actions = {
	default: (event) =>
		panelMutation(event, async () => {
			if (!isSuperadmin(event.locals.user)) error(404, 'Not found');
			const form = await event.request.formData();
			const value = form.get('required');
			if (value !== 'true' && value !== 'false')
				return fail(400, { message: 'Choose a valid two-factor policy' });
			const required = value === 'true';
			if (required && (!event.locals.user!.twoFactorEnabled || !event.locals.twoFactorVerified))
				return fail(400, {
					message: 'Set up and verify your own authenticator before requiring it for everyone'
				});
			await db
				.insert(securityPolicy)
				.values({ id: 'instance', requireTwoFactor: required })
				.onConflictDoUpdate({ target: securityPolicy.id, set: { requireTwoFactor: required } });
			await audit({
				action: 'security.two_factor_policy_changed',
				actorUserId: event.locals.user!.id,
				meta: { required }
			});
			return {
				ok: true,
				message: required
					? 'Two-factor authentication is now required for every account.'
					: 'Two-factor authentication is now optional. Existing authenticators remain enabled.'
			};
		})
};
