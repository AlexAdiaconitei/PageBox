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

		// admin plugin
		role: t.text('role').notNull().default('user'), // 'superadmin' | 'user'
		banned: t.boolean('banned').notNull().default(false),
		banReason: t.text('ban_reason'),
		banExpires: t.timestamp('ban_expires', { withTimezone: true }),

		// PageBox: forces a password change on next login (bootstrap admin, admin resets)
		mustChangePassword: t.boolean('must_change_password').notNull().default(false),

		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: t.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [t.uniqueIndex('user_email_key').on(table.email)]
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
