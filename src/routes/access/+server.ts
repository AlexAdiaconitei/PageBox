import { error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { config, siteIdForHost } from '$lib/server/config';
import { authorizeReader } from '$lib/server/auth/reader';

export const GET: RequestHandler = (event) => {
	if (
		!config.PAGEBOX_SITE_SUBDOMAINS ||
		event.locals.hostKind !== 'sites' ||
		siteIdForHost(event.url.host)
	)
		error(404, 'Not found');
	return authorizeReader(event);
};
