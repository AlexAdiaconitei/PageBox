import { error } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { authorizeReader } from '$lib/server/auth/reader';

export const GET: RequestHandler = (event) => {
	// Only the reader host reaches routes: a site's own domain is answered in the hook.
	if (event.locals.hostKind !== 'sites') error(404, 'Not found');
	return authorizeReader(event);
};
