import { redirect, type Handle, type HandleServerError, type ServerInit } from '@sveltejs/kit';
import { loadSession } from '$lib/server/auth/session';
import { config, hostKind } from '$lib/server/config';
import { probeHealth } from '$lib/server/health';
import { resolveSite } from '$lib/server/sites/resolve';
import { serveSite } from '$lib/server/sites/serve';
import { startup } from '$lib/server/startup';

export const init: ServerInit = async () => {
	await startup();
};

/**
 * Paths the *site* host is allowed to route into the SvelteKit app. Everything else on
 * that host is either a site path (`/s/<slug>/…`) or a 404.
 *
 * This list is a whitelist on purpose: it makes it impossible for a new admin route to
 * become reachable from the origin that hosts untrusted-ish static content (PLAN §7).
 */
const SITES_HOST_ROUTES = new Set(['/', '/login', '/logout', '/healthz']);

/** Admin-host paths reachable without a session. */
const PUBLIC_ADMIN_ROUTES = new Set(['/login', '/logout', '/healthz']);

export const handle: Handle = async ({ event, resolve }) => {
	const kind = hostKind(event.url.host);

	// Container and orchestrator probes (Docker HEALTHCHECK, Dokploy, compose
	// `service_healthy`) reach the app by IP, so they carry neither hostname. They still
	// need a real answer — but a reduced one, since the caller is unidentified.
	if (!kind && event.url.pathname === '/healthz') {
		const health = await probeHealth();
		return new Response(JSON.stringify({ status: health.ok ? 'ok' : 'degraded' }), {
			status: health.ok ? 200 : 503,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		});
	}

	// Anything else that is neither host is not ours: no redirect, no hint, no routing.
	if (!kind) return new Response('Not found', { status: 404 });
	event.locals.hostKind = kind;

	// Never serve internal paths from either host.
	if (event.url.pathname.startsWith('/__pb/')) return notFound();

	if (kind === 'sites') {
		const hit = await resolveSite(event.url.host, event.url.pathname);
		if (hit) {
			if (hit.needsTrailingSlashRedirect) {
				// Without this, every relative URL inside the HTML resolves one level up.
				return new Response(null, {
					status: 301,
					headers: { location: event.url.pathname + '/' + event.url.search }
				});
			}
			return serveSite(event, hit);
		}
		if (!SITES_HOST_ROUTES.has(event.url.pathname)) return notFound();
	} else if (event.url.pathname.startsWith(config.PAGEBOX_SITES_PREFIX + '/')) {
		// The admin host must never answer on the site prefix: one path, one meaning.
		return notFound();
	}

	event.locals.user = await loadSession(event, kind);

	if (kind === 'admin' && !PUBLIC_ADMIN_ROUTES.has(event.url.pathname)) {
		if (!event.locals.user) {
			const next = event.url.pathname + event.url.search;
			redirect(303, `/login?next=${encodeURIComponent(next)}`);
		}
		// A bootstrap or admin-reset password is a first-login credential, not a password:
		// nothing else in the panel opens until it has been replaced.
		if (event.locals.user.mustChangePassword && event.url.pathname !== '/account/password') {
			redirect(303, '/account/password');
		}
	}

	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'same-origin');
	if (kind === 'admin') {
		// The panel holds the credentials of the whole instance; it is never framed.
		response.headers.set('X-Frame-Options', 'DENY');
	}
	return response;
};

export const handleError: HandleServerError = ({ error, event }) => {
	const id = crypto.randomUUID();
	console.error(`[pagebox] error ${id} on ${event.url.host}${event.url.pathname}:`, error);
	// Never leak internals to a request that may come from hosted content.
	return { message: 'Internal error', id };
};

function notFound(): Response {
	return new Response('Not found', {
		status: 404,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
}
