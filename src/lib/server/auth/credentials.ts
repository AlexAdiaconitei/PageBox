import type { RequestEvent } from '@sveltejs/kit';
import { getConfig, type HostKind } from '../config';
import { authFor } from './index';

/**
 * Credential calls go through better-auth's HTTP handler rather than `auth.api.*`.
 *
 * The reason is rate limiting: better-auth's limiter is part of the handler pipeline, so
 * calling an endpoint function directly skips it — a loop against the login form is then
 * unlimited, which is exactly what it looked like before this existed. The request is
 * built here and handed to the handler in-process; the routes are never mounted, so the
 * site host still exposes nothing but sign-in and sign-out.
 */

export type CredentialResult = {
	ok: boolean;
	status: number;
	/** better-auth's error code, e.g. INVALID_PASSWORD — see `refusedForCredentials`. */
	code: string | null;
	/** True when better-auth refused because the caller has tried too often. */
	rateLimited: boolean;
	retryAfterSeconds: number;
	body: unknown;
};

async function call(
	event: RequestEvent,
	kind: HostKind,
	path: string,
	payload: Record<string, unknown>
): Promise<CredentialResult> {
	const auth = authFor(kind);
	const config = getConfig();
	const host = kind === 'admin' ? config.PAGEBOX_ADMIN_HOST : config.PAGEBOX_SITES_HOST;

	const headers = new Headers({ 'content-type': 'application/json' });
	// The limiter keys on the caller's address and the session is bound to its cookie, so
	// both have to survive the hop into the handler.
	// `origin` matters as much as the cookie: better-auth runs its own origin check on some
	// endpoints and answers 403 MISSING_OR_NULL_ORIGIN without it — which, mapped through a
	// credential form, reads as "wrong password" and sends people hunting for the wrong bug.
	// hooks.server.ts has already checked that this Origin is ours.
	for (const name of [
		'cookie',
		'user-agent',
		'origin',
		'referer',
		'x-forwarded-for',
		'cf-connecting-ip'
	]) {
		const value = event.request.headers.get(name);
		if (value) headers.set(name, value);
	}

	// better-auth will not trust a socket address when it has been told to read a header,
	// and everyone without that header then shares a single throttling bucket — one
	// attacker locks out the whole instance. Fill it in when the proxy did not.
	if (!headers.has('x-forwarded-for')) {
		const address = callerAddress(event);
		if (address) headers.set('x-forwarded-for', address);
	}

	const response = await auth.handler(
		new Request(`${config.PAGEBOX_PUBLIC_SCHEME}://${host}/__pb/auth${path}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload)
		})
	);

	applySetCookies(event, response);
	const body = await response.json().catch(() => null);

	if (!response.ok) {
		// The caller is told only "those credentials do not work"; the operator gets the
		// reason better-auth gave, which is the difference between a wrong password and a
		// misconfigured call.
		console.warn(
			`[pagebox] ${path} refused with ${response.status}:`,
			JSON.stringify(body)?.slice(0, 300)
		);
	}

	return {
		ok: response.ok,
		status: response.status,
		code: (body as { code?: string } | null)?.code ?? null,
		rateLimited: response.status === 429,
		retryAfterSeconds: Number(response.headers.get('x-retry-after') ?? 0),
		body
	};
}

/**
 * True when better-auth refused because the credentials were wrong, rather than because
 * the call itself was malformed. Anything else is a bug on our side and must not be
 * reported to the user as a bad password.
 */
export function refusedForCredentials(result: CredentialResult): boolean {
	if (result.ok || result.rateLimited) return false;
	if (result.status === 401) return true;
	return (
		result.code === 'INVALID_PASSWORD' ||
		result.code === 'INVALID_EMAIL_OR_PASSWORD' ||
		result.code === 'USER_NOT_FOUND'
	);
}

export const signInWithPassword = (
	event: RequestEvent,
	kind: HostKind,
	credentials: { email: string; password: string }
) => call(event, kind, '/sign-in/email', credentials);

/**
 * Ends every session of this account, the caller's included.
 *
 * The one thing missing when a session is believed stolen: suspending the account is the
 * superadmin's tool and too blunt for the person it belongs to, and a password change was
 * the only way to get here — which is a lot of ceremony when the password was never the
 * problem. Goes through the handler like every other credential call, so it is throttled
 * and its cookies come back the same way.
 */
export const revokeAllSessions = (event: RequestEvent) =>
	call(event, 'admin', '/revoke-sessions', {});

export const changeOwnPassword = (
	event: RequestEvent,
	credentials: { currentPassword: string; newPassword: string }
) =>
	call(event, 'admin', '/change-password', {
		...credentials,
		revokeOtherSessions: true
	});

function callerAddress(event: RequestEvent): string | null {
	try {
		return event.getClientAddress();
	} catch {
		// adapter-node throws when ADDRESS_HEADER is set and the header is missing.
		return null;
	}
}

/**
 * Copies the handler's cookies onto the SvelteKit response. The sveltekitCookies plugin
 * already does this for endpoints it sees, but a redirect out of a form action must not
 * depend on that: a sign-in that quietly loses its cookie is a login loop.
 */
function applySetCookies(event: RequestEvent, response: Response): void {
	for (const raw of response.headers.getSetCookie()) {
		const [pair, ...attributes] = raw.split(';');
		const separator = pair.indexOf('=');
		if (separator < 0) continue;

		const name = pair.slice(0, separator).trim();
		const value = decodeURIComponent(pair.slice(separator + 1).trim());
		const options: Parameters<typeof event.cookies.set>[2] = { path: '/' };

		for (const attribute of attributes) {
			const [rawKey, rawValue] = attribute.split('=');
			const key = rawKey.trim().toLowerCase();
			const attributeValue = rawValue?.trim();
			if (key === 'path') options.path = attributeValue ?? '/';
			else if (key === 'max-age') options.maxAge = Number(attributeValue);
			else if (key === 'expires') options.expires = new Date(attributeValue ?? '');
			else if (key === 'samesite')
				options.sameSite = attributeValue?.toLowerCase() as 'lax' | 'strict' | 'none';
			else if (key === 'httponly') options.httpOnly = true;
			else if (key === 'secure') options.secure = true;
			// `domain` is deliberately dropped: PageBox cookies are host-only by design.
		}

		event.cookies.set(name, value, options);
	}
}
