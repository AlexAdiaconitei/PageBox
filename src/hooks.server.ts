import { redirect, type Handle, type HandleServerError, type ServerInit } from '@sveltejs/kit';
import { loadSession } from '$lib/server/auth/session';
import { isTwoFactorRequired, twoFactorGate } from '$lib/server/auth/two-factor';
import { acceptReader, accessUrl, loadSiteSession } from '$lib/server/auth/reader';
import { config, hostKind, siteUrl } from '$lib/server/config';
import { sameOriginMutation } from '$lib/server/auth/origin';
import { errorResponse, notFoundResponse } from '$lib/server/errorPage';
import { probeHealth } from '$lib/server/health';
import { lookupSiteByHost, resolveDomainPath, resolveSite } from '$lib/server/sites/resolve';
import { guardPrivate, serveSite } from '$lib/server/sites/serve';
import { startup } from '$lib/server/startup';

export const init: ServerInit = async () => {
	await startup();
};
const SITES_HOST_ROUTES = new Set([
	'/',
	'/login',
	'/logout',
	'/healthz',
	'/access',
	'/two-factor',
	'/two-factor/setup'
]);
const PUBLIC_ADMIN_ROUTES = new Set(['/login', '/logout', '/healthz', '/two-factor']);
const isApiPath = (pathname: string) => pathname === '/api' || pathname.startsWith('/api/');

export const handle: Handle = async ({ event, resolve }) => {
	const kind = hostKind(event.url.host);
	event.locals.user = null;
	event.locals.sessionId = null;
	event.locals.twoFactorVerified = false;
	if (!kind && event.url.pathname === '/healthz') {
		const health = await probeHealth();
		return new Response(JSON.stringify({ status: health.ok ? 'ok' : 'degraded' }), {
			status: health.ok ? 200 : 503,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		});
	}

	// A site's own domain: uploaded content from `/`, plus the one callback that turns a
	// reader code into a cookie for this origin. Nothing else of PageBox answers here.
	if (!kind) {
		const owned = await lookupSiteByHost(event.url.host);
		if (!owned) return notFoundResponse(event.request, null);
		event.locals.hostKind = 'sites';
		if (event.url.pathname === '/__pb/accept' && event.request.method === 'GET')
			return acceptReader(event, owned.id);
		if (event.url.pathname === '/__pb' || event.url.pathname.startsWith('/__pb/'))
			return notFoundResponse(event.request, 'sites');
		if (owned.visibility === 'private') event.locals.user = await loadSiteSession(event, owned.id);
		return serveSite(event, resolveDomainPath(owned, event.url.pathname));
	}
	event.locals.hostKind = kind;
	if (event.url.pathname.startsWith('/__pb/')) return notFoundResponse(event.request, kind);

	if (kind === 'sites') {
		const hit = await resolveSite(event.url.host, event.url.pathname);
		if (hit) {
			if (!hit.siteRef.hostname) {
				if (hit.siteRef.visibility === 'private')
					event.locals.user = await loadSession(event, kind);
				return serveSite(event, hit);
			}
			// A site with its own domain is built for `/`, so its files cannot be served under
			// `/s/<slug>/`; old links are forwarded instead. The reader login origin must
			// never execute uploaded content either.
			if (hit.siteRef.disabled)
				return notFoundResponse(event.request, kind, {
					'cache-control': 'private, no-store',
					'cdn-cache-control': 'no-store',
					'cloudflare-cdn-cache-control': 'no-store',
					vary: 'Cookie'
				});
			if (event.request.method !== 'GET' && event.request.method !== 'HEAD')
				return serveSite(event, hit);
			if (hit.siteRef.visibility === 'private') {
				event.locals.user = await loadSession(event, kind);
				const denial = await guardPrivate(event, hit.siteRef);
				if (denial) return denial;
			}
			const path = '/' + hit.subpath + event.url.search;
			const location =
				hit.siteRef.visibility === 'private'
					? accessUrl(hit.siteRef, path)
					: new URL(path, siteUrl(hit.siteRef)).href;
			return new Response(null, {
				status: 302,
				headers: {
					location,
					'cache-control': 'private, no-store',
					'cdn-cache-control': 'no-store',
					'cloudflare-cdn-cache-control': 'no-store',
					'referrer-policy': 'no-referrer',
					vary: 'Cookie'
				}
			});
		}
		if (!SITES_HOST_ROUTES.has(event.url.pathname)) return notFoundResponse(event.request, kind);
	} else if (
		event.url.pathname === '/access' ||
		event.url.pathname.startsWith(config.PAGEBOX_SITES_PREFIX + '/')
	) {
		return notFoundResponse(event.request, kind);
	}

	if (!sameOriginMutation(event, kind))
		return errorResponse(event.request, {
			status: 403,
			title: 'Cross-site request blocked',
			detail: 'This submission came from another site, so it was not processed.',
			note: 'Open the page again on this host and retry.',
			brand: kind,
			host: kind === 'admin' ? config.PAGEBOX_ADMIN_HOST : config.PAGEBOX_SITES_HOST,
			action: { href: '/', label: 'Start again' }
		});
	event.locals.user = await loadSession(event, kind, { allowIncompleteTwoFactor: true });
	if (event.locals.user && !['/login', '/logout', '/healthz'].includes(event.url.pathname)) {
		const gate = twoFactorGate(
			event.locals.user.twoFactorEnabled,
			event.locals.twoFactorVerified,
			await isTwoFactorRequired()
		);
		const hasBearer = /^Bearer /i.test(event.request.headers.get('authorization') ?? '');
		if (gate && isApiPath(event.url.pathname) && !hasBearer) {
			return new Response(JSON.stringify({ error: 'two-factor authentication required' }), {
				status: 403,
				headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
			});
		}
		const gatePath = gate === 'verify' ? '/two-factor' : '/two-factor/setup';
		const changingPassword = kind === 'admin' && event.url.pathname === '/account/password';
		if (
			gate &&
			!isApiPath(event.url.pathname) &&
			event.url.pathname !== gatePath &&
			!(gate === 'setup' && changingPassword)
		) {
			redirect(
				303,
				gatePath + '?next=' + encodeURIComponent(event.url.pathname + event.url.search)
			);
		}
	}
	if (
		kind === 'admin' &&
		!PUBLIC_ADMIN_ROUTES.has(event.url.pathname) &&
		!isApiPath(event.url.pathname)
	) {
		if (!event.locals.user)
			redirect(303, '/login?next=' + encodeURIComponent(event.url.pathname + event.url.search));
		if (
			event.locals.user.mustChangePassword &&
			event.url.pathname !== '/account/password' &&
			event.url.pathname !== '/two-factor'
		)
			redirect(303, '/account/password');
	}
	const response = await resolve(event);
	if (event.url.pathname.startsWith('/two-factor') || event.url.pathname === '/security') {
		response.headers.set('Cache-Control', 'private, no-store');
		response.headers.set('Referrer-Policy', 'same-origin');
	}
	response.headers.set('X-Content-Type-Options', 'nosniff');
	if (!response.headers.has('Referrer-Policy'))
		response.headers.set('Referrer-Policy', 'same-origin');
	response.headers.set('X-Frame-Options', 'DENY');
	return response;
};

export const handleError: HandleServerError = ({ error, event }) => {
	const id = crypto.randomUUID();
	console.error(
		'[pagebox] error ' + id + ' on ' + event.url.host + event.url.pathname + ':',
		error
	);
	return { message: 'Internal error', id };
};
