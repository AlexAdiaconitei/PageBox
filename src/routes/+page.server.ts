import type { PageServerLoad } from './$types';
import { config } from '$lib/server/config';

export const load: PageServerLoad = async ({ locals }) => {
	return {
		hostKind: locals.hostKind,
		adminHost: config.PAGEBOX_ADMIN_HOST,
		sitesHost: config.PAGEBOX_SITES_HOST,
		sitesPrefix: config.PAGEBOX_SITES_PREFIX
	};
};
