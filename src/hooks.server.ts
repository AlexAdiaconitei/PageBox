import {
	redirect,
	type Handle,
	type HandleServerError,
	type RequestEvent,
	type ServerInit
} from '@sveltejs/kit';
import { loadSession } from '$lib/server/auth/session';
import { config, hostKind, type HostKind } from '$lib/server/config';
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

/** Admin-host paths reachable without a panel session. */
const PUBLIC_ADMIN_ROUTES = new Set(['/login', '/logout', '/healthz']);

/**
 * The deploy API authenticates with a bearer token and answers in JSON. Redirecting it to
 * a login page would turn every unauthenticated call into a 303 that a CI job reads as
 * success, so it opts out of the session gate and does its own 401.
 */
const isApiPath = (pathname: string) => pathname === '/api' || pathname.startsWith('/api/');

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
			// Only private sites pay for a session lookup. A public asset request is the
			// hot path of this whole application and has nothing to authorise.
			if (hit.siteRef.visibility === 'private') {
				event.locals.user = await loadSession(event, kind);
			}
			return serveSite(event, hit);
		}
		if (!SITES_HOST_ROUTES.has(event.url.pathname)) return notFound();
	} else if (event.url.pathname.startsWith(config.PAGEBOX_SITES_PREFIX + '/')) {
		// The admin host must never answer on the site prefix: one path, one meaning.
		return notFound();
	}

	// CSRF: cookie-authenticated mutations must come from our own origin. Done here, and
	// not by SvelteKit's built-in check, because that one compares against a URL rebuilt
	// from proxy headers (see vite.config.ts).
	if (!sameOriginMutation(event, kind)) {
		return new Response('Cross-site form submissions are forbidden', {
			status: 403,
			headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
		});
	}

	event.locals.user = await loadSession(event, kind);

	if (
		kind === 'admin' &&
		!PUBLIC_ADMIN_ROUTES.has(event.url.pathname) &&
		!isApiPath(event.url.pathname)
	) {
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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True when the request is safe, token-authenticated, or carries an Origin whose hostname
 * is the host it is addressing.
 *
 * Ports and scheme are deliberately not compared: behind a tunnel the browser sees
 * https://pagebox.example.com while the app sees http://…:3000, and it is the *hostname*
 * that decides which origin a cookie came from.
 */
function sameOriginMutation(event: RequestEvent, kind: HostKind): boolean {
	if (SAFE_METHODS.has(event.request.method)) return true;

	// The deploy API authenticates with a bearer token and no cookie, so it cannot be
	// driven by a browser holding somebody's session. CI sends no Origin header.
	const authorization = event.request.headers.get('authorization');
	if (authorization?.toLowerCase().startsWith('bearer ')) return true;

	const origin = event.request.headers.get('origin');
	if (!origin) return false;

	let originHost: string;
	try {
		originHost = new URL(origin).hostname.toLowerCase();
	} catch {
		return false;
	}

	const expected = (kind === 'admin' ? config.PAGEBOX_ADMIN_HOST : config.PAGEBOX_SITES_HOST).split(
		':'
	)[0];
	return originHost === expected;
}

function notFound(): Response {
	return new Response('Not found', {
		status: 404,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
	});
}
