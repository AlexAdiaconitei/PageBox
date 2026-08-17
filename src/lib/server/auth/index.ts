import { getRequestEvent } from '$app/server';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin } from 'better-auth/plugins/admin';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { createAccessControl } from 'better-auth/plugins/access';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getConfig, type HostKind } from '../config';
import { db } from '../db';
import { account, session, user, verification } from '../db/schema';
import { newId } from '../ids';
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
 * PageBox names its roles `superadmin` and `user`; the admin plugin only accepts role
 * names it can resolve to a permission set, so both are declared here over the plugin's
 * own statements. `superadmin` gets the full admin set, `user` the plain one.
 */
const ac = createAccessControl(defaultStatements);
const roles = {
	superadmin: ac.newRole(adminAc.statements),
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
			schema: { user, session, account, verification }
		}),

		emailAndPassword: {
			enabled: true,
			// Accounts are created by a superadmin, never by whoever finds the login page.
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
				}
			}
		},

		advanced: {
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

		rateLimit: {
			enabled: true,
			window: 60,
			max: 60,
			customRules: {
				// Password guessing is the attack this endpoint has.
				'/sign-in/email': { window: 300, max: 10 },
				'/change-password': { window: 300, max: 10 }
			}
		},

		plugins:
			kind === 'admin'
				? [
						admin({ ac, roles, adminRoles: ['superadmin'], defaultRole: 'user' }),
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

export const isSuperadmin = (user: SessionUser | null): boolean => user?.role === 'superadmin';
