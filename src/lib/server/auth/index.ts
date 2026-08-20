import { getRequestEvent } from '$app/server';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { apiKey } from '@better-auth/api-key';
import { admin } from 'better-auth/plugins/admin';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { createAccessControl } from 'better-auth/plugins/access';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getConfig, type HostKind } from '../config';
import { db } from '../db';
import { account, apikey, rateLimit, session, user, verification } from '../db/schema';
import { newId, TOKEN_PREFIX } from '../ids';
import { lazy } from '../lazy';

/**
 * Two auth instances over the same tables, one per hostname.
 *
 * The panel and the hosted sites are different origins on purpose (docs/PLAN §D1), so
 * each needs its own cookie. A single instance would issue one cookie usable on both,
 * which is exactly the escalation the host split exists to prevent.
 *
 * The instances differ in three things: cookie name, session lifetime, and the `scope`
 * stamped on every session row. `requireSession` below refuses a session whose scope does
 * not match the host it arrived on, so a cookie value lifted from one host is inert on the
 * other even if someone replants it under the other name.
 *
 * There is no HTTP surface: `basePath` points at a namespace we never route, and callers
 * use `auth.api.*` directly. That keeps the site host down to login and logout instead of
 * better-auth's full route set.
 */

const DAY = 60 * 60 * 24;

/**
 * PageBox names its roles `superadmin`, `admin` and `user`; the admin plugin only accepts
 * role names it can resolve to a permission set, so all three are declared here over the
 * plugin's own statements (docs/access.md).
 *
 * `admin` is the interesting one, and it is deliberately not "the admin set minus a bit":
 *
 * - no `set-role`. No PageBox role has it: the plugin refuses to assign a role that is one
 *   of its own `adminRoles` whoever asks, so role changes are written by the users route
 *   itself, under guards stricter than anything expressible here. An admin cannot make
 *   another admin, promote anyone, or demote the account that seated it.
 * - no `delete`, because a deleted account takes its `created_by_user_id` attribution with
 *   it, and suspending does everything an admin actually needs.
 * - no `impersonate`, which would hand one admin another's session for the asking.
 *
 * What the plugin cannot express is *which* accounts an admin may reach — it has no notion
 * of one admin's users versus another's. That half lives in `manages()` in the users route,
 * and every action there goes through it. This list is the ceiling; that function is the
 * boundary.
 */
const ac = createAccessControl(defaultStatements);
const roles = {
	superadmin: ac.newRole(adminAc.statements),
	admin: ac.newRole({
		user: ['create', 'list', 'get', 'ban', 'set-password'],
		session: ['list', 'revoke']
	}),
	user: ac.newRole(userAc.statements)
};

/** Session scope stored in the DB, one per host. */
export type SessionScope = 'admin' | 'view';
export const scopeFor = (kind: HostKind): SessionScope => (kind === 'admin' ? 'admin' : 'view');

function createAuth(kind: HostKind) {
	const config = getConfig();
	const host = kind === 'admin' ? config.PAGEBOX_ADMIN_HOST : config.PAGEBOX_SITES_HOST;
	const scope = scopeFor(kind);

	return betterAuth({
		appName: 'PageBox',
		baseURL: `${config.PAGEBOX_PUBLIC_SCHEME}://${host}`,
		basePath: '/__pb/auth', // never routed: /__pb/* is blocked in hooks.server.ts
		secret: config.AUTH_SECRET,

		database: drizzleAdapter(db, {
			provider: 'pg',
			schema: { user, session, account, verification, apikey, rateLimit }
		}),

		/**
		 * Which origins may drive this instance.
		 *
		 * better-auth defaults to its `baseURL`, which carries no port — so a dev server on
		 * :5173, or anything behind a proxy that terminates elsewhere, is refused with
		 * INVALID_ORIGIN. PageBox already has an origin rule (hooks.server.ts): the hostname
		 * must be one of the two configured hosts, and scheme and port are not compared,
		 * because behind a tunnel neither survives. This applies the same rule here rather
		 * than keeping a second, stricter one that only fails in development.
		 */
		trustedOrigins: (request) => {
			const canonical = [
				`${config.PAGEBOX_PUBLIC_SCHEME}://${config.PAGEBOX_ADMIN_HOST}`,
				`${config.PAGEBOX_PUBLIC_SCHEME}://${config.PAGEBOX_SITES_HOST}`
			];
			const ours = [config.PAGEBOX_ADMIN_HOST, config.PAGEBOX_SITES_HOST].map(
				(name) => name.split(':')[0]
			);

			const origin = request?.headers.get('origin');
			if (!origin) return canonical;
			try {
				return ours.includes(new URL(origin).hostname) ? [...canonical, origin] : canonical;
			} catch {
				return canonical;
			}
		},

		emailAndPassword: {
			enabled: true,
			// Accounts are issued by an admin, never by whoever finds the login page.
			disableSignUp: true,
			minPasswordLength: 10,
			maxPasswordLength: 200
		},

		session: {
			// The panel is a working tool; a reading session on the site host is short,
			// because that cookie travels with every asset request of every private site.
			expiresIn: kind === 'admin' ? 30 * DAY : 12 * 60 * 60,
			updateAge: kind === 'admin' ? DAY : 60 * 60,
			additionalFields: {
				scope: { type: 'string', required: false, defaultValue: scope, input: false }
			}
		},

		user: {
			additionalFields: {
				mustChangePassword: {
					type: 'boolean',
					required: false,
					defaultValue: false,
					input: false
				},
				// The admin plugin declares `role` and `banned`, and it only runs on the admin
				// instance — so without this the site host reads a user with neither, and an
				// admin arrives as an ordinary user while a banned one arrives clean.
				...(kind === 'admin'
					? {}
					: {
							role: {
								type: 'string',
								required: false,
								defaultValue: 'user',
								input: false
							},
							banned: {
								type: 'boolean',
								required: false,
								defaultValue: false,
								input: false
							}
						})
			}
		},

		advanced: {
			// The rate limiter and the session rows record the caller's address, and behind
			// Traefik or a tunnel the socket address is the proxy's.
			ipAddress: { ipAddressHeaders: ['x-forwarded-for', 'cf-connecting-ip'] },
			// Yields `pb_admin.session_token` / `pb_view.session_token`, both host-only:
			// no Domain attribute, so neither travels to any other subdomain.
			cookiePrefix: kind === 'admin' ? 'pb_admin' : 'pb_view',
			useSecureCookies: config.PAGEBOX_PUBLIC_SCHEME === 'https',
			database: { generateId: () => newId() }
		},

		databaseHooks: {
			session: {
				create: {
					before: async (data) => ({ data: { ...data, scope } })
				}
			}
		},

		// better-auth's own limiter, which is why sign-in goes through `auth.handler`
		// instead of `auth.api` (see signIn in auth/credentials.ts): the limiter lives in
		// the handler pipeline, so calling the endpoint function directly skips it.
		//
		// Counters live in Postgres: a restart must not hand an attacker a fresh budget,
		// and replicas have to share one window.
		rateLimit: {
			enabled: true,
			storage: 'database',
			modelName: 'rateLimit',
			window: 60,
			max: 120,
			customRules: {
				// Password guessing is the attack these endpoints have.
				'/sign-in/email': { window: config.LOGIN_WINDOW_SECONDS, max: config.LOGIN_MAX_ATTEMPTS },
				'/change-password': {
					window: config.LOGIN_WINDOW_SECONDS,
					max: config.LOGIN_MAX_ATTEMPTS
				}
			}
		},

		plugins:
			kind === 'admin'
				? [
						admin({ ac, roles, adminRoles: ['superadmin', 'admin'], defaultRole: 'user' }),
						// Deploy tokens. The plugin owns generation, hashing, expiry,
						// enable/disable and per-key throttling; PageBox only records which
						// site a key may deploy to, in its metadata.
						apiKey({
							defaultPrefix: TOKEN_PREFIX,
							defaultKeyLength: 40,
							enableMetadata: true,
							// A deploy token must never turn into a panel session: it is held
							// by CI, not by a person.
							enableSessionForAPIKeys: false,
							storage: 'database',
							rateLimit: {
								enabled: true,
								timeWindow: config.API_KEY_WINDOW_SECONDS * 1000,
								maxRequests: config.API_KEY_MAX_REQUESTS
							}
						}),
						sveltekitCookies(getRequestEvent)
					]
				: [sveltekitCookies(getRequestEvent)]
	});
}

export const adminAuth = lazy(() => createAuth('admin'));
export const viewAuth = lazy(() => createAuth('sites'));

export function authFor(kind: HostKind) {
	return kind === 'admin' ? adminAuth : viewAuth;
}

export type SessionUser = {
	id: string;
	email: string;
	name: string;
	role: string;
	banned: boolean;
	mustChangePassword: boolean;
};

/**
 * The three global roles, in order of standing. Anything per-site is a grant, not a role
 * (see perms.ts) — these say what someone is on the *instance*, not on any one site.
 */
export const globalRoles = ['superadmin', 'admin', 'user'] as const;
export type GlobalRole = (typeof globalRoles)[number];

export const isSuperadmin = (user: SessionUser | null): boolean => user?.role === 'superadmin';

/**
 * True for the superadmin and for an admin — the accounts that run something rather than
 * being granted access to it. Used for the surfaces that exist to administer: creating
 * sites and groups, issuing accounts.
 *
 * It says nothing about *what* they may administer. An admin holds this and still reaches
 * only their own sites and their own accounts.
 */
export const isAdmin = (user: SessionUser | null): boolean =>
	user?.role === 'superadmin' || user?.role === 'admin';
