import { sql } from 'drizzle-orm';
import * as t from 'drizzle-orm/pg-core';
import { pgTable } from 'drizzle-orm/pg-core';

/**
 * better-auth core tables. Column names are snake_case in Postgres, camelCase in TS —
 * the drizzle adapter matches on the TS keys, so these must keep better-auth's names.
 *
 * PageBox additions are marked; they are plain extra columns, declared to better-auth as
 * `additionalFields` so they survive its queries.
 */

export const user = pgTable(
	'user',
	{
		id: t.text('id').primaryKey(),
		name: t.text('name').notNull().default(''),
		email: t.text('email').notNull(),
		emailVerified: t.boolean('email_verified').notNull().default(false),
		image: t.text('image'),

		// admin plugin. 'superadmin' | 'admin' | 'user' — see docs/access.md.
		//
		// There is exactly one superadmin: the platform account, created at first boot and
		// moved only by handing the seat to somebody else. An `admin` runs their own patch —
		// the sites they create and the accounts they issue — and has no standing on
		// anybody else's. A `user` has no global standing at all; everything it can do comes
		// from a per-site grant.
		role: t.text('role').notNull().default('user'),
		banned: t.boolean('banned').notNull().default(false),
		banReason: t.text('ban_reason'),
		banExpires: t.timestamp('ban_expires', { withTimezone: true }),

		// PageBox: forces a password change on next login (bootstrap admin, admin resets)
		mustChangePassword: t.boolean('must_change_password').notNull().default(false),

		/**
		 * PageBox: which admin issued this account, and therefore who may administer it.
		 *
		 * This is the whole boundary between two admins. Without it an admin can reset any
		 * other account's password, sign in as them, and reach the sites of the admin who
		 * created them — so "admins manage their own patch" would be a description of the
		 * screen rather than a rule. Null for the superadmin and for anything the superadmin
		 * created, which only the superadmin administers anyway.
		 */
		createdByUserId: t.text('created_by_user_id').references((): t.AnyPgColumn => user.id, {
			onDelete: 'set null'
		}),

		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: t.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		t.uniqueIndex('user_email_key').on(table.email),
		t.index('user_created_by_idx').on(table.createdByUserId),
		/**
		 * One superadmin, enforced by Postgres rather than by whoever remembered to check.
		 *
		 * A partial unique index over a constant column: every row with `role = 'superadmin'`
		 * has the same value there, so a second one collides. The guards in the panel give a
		 * readable error; this is what makes the invariant true — including for a migration,
		 * a psql session, or a code path nobody has written yet.
		 */
		t
			.uniqueIndex('user_single_superadmin')
			.on(table.role)
			.where(sql`role = 'superadmin'`)
	]
);

export const session = pgTable(
	'session',
	{
		id: t.text('id').primaryKey(),
		token: t.text('token').notNull(),
		userId: t
			.text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),

		// PageBox: which hostname this session is valid on. A `view` session presented on
		// the admin host (or the reverse) is rejected, so a stolen cookie value cannot be
		// replanted across the host boundary.
		scope: t.text('scope').notNull().default('admin'), // 'admin' | 'view'

		expiresAt: t.timestamp('expires_at', { withTimezone: true }).notNull(),
		ipAddress: t.text('ip_address'),
		userAgent: t.text('user_agent'),
		impersonatedBy: t.text('impersonated_by'),
		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: t.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		t.uniqueIndex('session_token_key').on(table.token),
		t.index('session_user_id_idx').on(table.userId)
	]
);

export const account = pgTable(
	'account',
	{
		id: t.text('id').primaryKey(),
		accountId: t.text('account_id').notNull(),
		providerId: t.text('provider_id').notNull(),
		userId: t
			.text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		accessToken: t.text('access_token'),
		refreshToken: t.text('refresh_token'),
		idToken: t.text('id_token'),
		accessTokenExpiresAt: t.timestamp('access_token_expires_at', { withTimezone: true }),
		refreshTokenExpiresAt: t.timestamp('refresh_token_expires_at', { withTimezone: true }),
		scope: t.text('scope'),
		password: t.text('password'), // argon2id hash, better-auth's default
		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: t.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [t.index('account_user_id_idx').on(table.userId)]
);

export const verification = pgTable(
	'verification',
	{
		id: t.text('id').primaryKey(),
		identifier: t.text('identifier').notNull(),
		value: t.text('value').notNull(),
		expiresAt: t.timestamp('expires_at', { withTimezone: true }).notNull(),
		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: t.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [t.index('verification_identifier_idx').on(table.identifier)]
);

/**
 * `@better-auth/api-key` table. PageBox deploy tokens are api keys: the plugin owns
 * generation, hashing, expiry, enable/disable and per-key rate limiting, so none of that
 * is reimplemented here. Which site a key may deploy to lives in `metadata`.
 */
export const apikey = pgTable(
	'apikey',
	{
		id: t.text('id').primaryKey(),
		configId: t.text('config_id').notNull().default('default'),
		name: t.text('name'),
		/** First characters of the key, kept to identify it in the UI. */
		start: t.text('start'),
		prefix: t.text('prefix'),
		/** Hashed by the plugin; the plaintext exists only in the response that created it. */
		key: t.text('key').notNull(),
		/** Owner — the user who issued the key. */
		referenceId: t.text('reference_id').notNull(),

		refillInterval: t.integer('refill_interval'),
		refillAmount: t.integer('refill_amount'),
		lastRefillAt: t.timestamp('last_refill_at', { withTimezone: true }),

		enabled: t.boolean('enabled').notNull().default(true),
		rateLimitEnabled: t.boolean('rate_limit_enabled').notNull().default(true),
		rateLimitTimeWindow: t.integer('rate_limit_time_window'),
		rateLimitMax: t.integer('rate_limit_max'),
		requestCount: t.integer('request_count').notNull().default(0),
		remaining: t.integer('remaining'),
		lastRequest: t.timestamp('last_request', { withTimezone: true }),

		expiresAt: t.timestamp('expires_at', { withTimezone: true }),
		permissions: t.text('permissions'),
		metadata: t.text('metadata'),

		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: t.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		t.index('apikey_reference_idx').on(table.referenceId),
		t.index('apikey_start_idx').on(table.start)
	]
);

/**
 * better-auth's rate limit counters. Stored in Postgres rather than in memory so a restart
 * does not hand an attacker a fresh budget, and so replicas share one window.
 */
export const rateLimit = pgTable('rate_limit', {
	id: t.text('id').primaryKey(),
	key: t.text('key').notNull(),
	count: t.integer('count').notNull().default(0),
	lastRequest: t.bigint('last_request', { mode: 'number' })
});
