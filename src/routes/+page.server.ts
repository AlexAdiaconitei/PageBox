import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { config } from '$lib/server/config';

export const load: PageServerLoad = async ({ locals }) => {
	// The admin host has no landing page of its own: signed in goes to the panel, signed
	// out is already redirected to /login by hooks.server.ts.
	if (locals.hostKind === 'admin') redirect(303, '/sites');

	return {
		hostKind: locals.hostKind,
		signedIn: Boolean(locals.user),
		sitesHost: config.PAGEBOX_SITES_HOST,
		sitesPrefix: config.PAGEBOX_SITES_PREFIX
	};
};
