import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { config } from '$lib/server/config';

export const load: LayoutServerLoad = async ({ locals }) => {
	// The site host never routes into the panel, but a group layout is the wrong place to
	// rely on that: check it here too.
	if (locals.hostKind !== 'admin' || !locals.user) redirect(303, '/login');

	return {
		user: locals.user,
		adminHost: config.PAGEBOX_ADMIN_HOST,
		sitesHost: config.PAGEBOX_SITES_HOST
	};
};
