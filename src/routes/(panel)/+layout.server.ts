import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { isAdmin } from '$lib/server/auth';
import { config } from '$lib/server/config';
import { hasOperatorAccess } from '$lib/server/perms';

export const load: LayoutServerLoad = async ({ locals }) => {
	// The site host never routes into the panel, but a group layout is the wrong place to
	// rely on that: check it here too.
	if (locals.hostKind !== 'admin' || !locals.user) redirect(303, '/login');

	return {
		user: locals.user,
		adminHost: config.PAGEBOX_ADMIN_HOST,
		sitesHost: config.PAGEBOX_SITES_HOST,
		canSeeOps: await hasOperatorAccess(locals.user),
		canAdminister: isAdmin(locals.user)
	};
};
