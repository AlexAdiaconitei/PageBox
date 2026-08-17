import * as t from 'drizzle-orm/pg-core';
import { pgTable } from 'drizzle-orm/pg-core';
import { user } from './auth';

/** Domain tables (docs/PLAN-static-hosting.md §4). Ids are ULIDs unless noted. */

export const visibilityValues = ['public', 'private'] as const;
export const deploymentStatusValues = ['uploading', 'ready', 'failed'] as const;
export const deploymentSourceValues = ['api', 'panel-upload'] as const;
export const principalTypeValues = ['user', 'group'] as const;
export const siteRoleValues = ['viewer', 'deployer', 'owner'] as const;

export type Visibility = (typeof visibilityValues)[number];
export type DeploymentStatus = (typeof deploymentStatusValues)[number];
export type SiteRole = (typeof siteRoleValues)[number];
export type PrincipalType = (typeof principalTypeValues)[number];

export const group = pgTable(
	'group',
	{
		id: t.text('id').primaryKey(),
		slug: t.text('slug').notNull(),
		name: t.text('name').notNull(),
		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [t.uniqueIndex('group_slug_key').on(table.slug)]
);

export const groupMember = pgTable(
	'group_member',
	{
		groupId: t
			.text('group_id')
			.notNull()
			.references(() => group.id, { onDelete: 'cascade' }),
		userId: t
			.text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		t.primaryKey({ columns: [table.groupId, table.userId] }),
		t.index('group_member_user_idx').on(table.userId)
	]
);

export const site = pgTable(
	'site',
	{
		id: t.text('id').primaryKey(),
		slug: t.text('slug').notNull(),
		name: t.text('name').notNull(),
		visibility: t.text('visibility').notNull().default('private').$type<Visibility>(),

		/** '/s/<slug>/' in v1, '/' once a site moves to its own hostname (v2, §12). */
		basePath: t.text('base_path').notNull(),
		/** v2 only: dedicated hostname for this site. */
		hostname: t.text('hostname'),

		spaFallback: t.boolean('spa_fallback').notNull().default(false),
		/** No FK: deployments reference the site, not the other way round. */
		activeDeploymentId: t.text('active_deployment_id'),
		ownerUserId: t.text('owner_user_id').references(() => user.id, { onDelete: 'set null' }),

		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		archivedAt: t.timestamp('archived_at', { withTimezone: true })
	},
	(table) => [
		t.uniqueIndex('site_slug_key').on(table.slug),
		t.uniqueIndex('site_hostname_key').on(table.hostname),
		t.index('site_owner_idx').on(table.ownerUserId)
	]
);

export const deployment = pgTable(
	'deployment',
	{
		id: t.text('id').primaryKey(), // ULID: sortable by creation time
		siteId: t
			.text('site_id')
			.notNull()
			.references(() => site.id, { onDelete: 'cascade' }),
		status: t.text('status').notNull().default('uploading').$type<DeploymentStatus>(),
		fileCount: t.integer('file_count').notNull().default(0),
		totalBytes: t.bigint('total_bytes', { mode: 'number' }).notNull().default(0),
		/** sha256 of the uploaded archive — lets a retrying CI job detect a duplicate. */
		checksum: t.text('checksum'),
		/**
		 * Which set of extraction rules produced this deployment. The same archive can
		 * expand differently after a rule changes (rebasing onto a single root did), so a
		 * checksum alone is not enough to decide two deployments are the same thing.
		 */
		ingestVersion: t.integer('ingest_version').notNull().default(1),
		source: t.text('source').notNull().default('api'),
		notes: t.text('notes'),

		createdByUserId: t.text('created_by_user_id').references(() => user.id, {
			onDelete: 'set null'
		}),
		createdByTokenId: t.text('created_by_token_id'),

		/** Preflight warnings the uploader acknowledged (§6.3). */
		warnings: t.jsonb('warnings').$type<string[]>(),
		acknowledgedAt: t.timestamp('acknowledged_at', { withTimezone: true }),
		/** Result of the post-activation link check (§6.3), null if not run. */
		brokenAssetCount: t.integer('broken_asset_count'),

		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		readyAt: t.timestamp('ready_at', { withTimezone: true })
	},
	(table) => [
		t.index('deployment_site_created_idx').on(table.siteId, table.createdAt),
		t.index('deployment_status_idx').on(table.status)
	]
);

export const siteGrant = pgTable(
	'site_grant',
	{
		id: t.text('id').primaryKey(),
		siteId: t
			.text('site_id')
			.notNull()
			.references(() => site.id, { onDelete: 'cascade' }),
		principalType: t.text('principal_type').notNull().$type<PrincipalType>(),
		principalId: t.text('principal_id').notNull(),
		role: t.text('role').notNull().$type<SiteRole>(),
		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		t.uniqueIndex('site_grant_unique').on(table.siteId, table.principalType, table.principalId),
		t.index('site_grant_principal_idx').on(table.principalType, table.principalId)
	]
);

export const auditLog = pgTable(
	'audit_log',
	{
		id: t.text('id').primaryKey(),
		actorUserId: t.text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
		actorTokenId: t.text('actor_token_id'),
		action: t.text('action').notNull(),
		targetType: t.text('target_type'),
		targetId: t.text('target_id'),
		meta: t.jsonb('meta').$type<Record<string, unknown>>(),
		ip: t.text('ip'),
		createdAt: t.timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		t.index('audit_log_created_idx').on(table.createdAt),
		t.index('audit_log_actor_idx').on(table.actorUserId),
		t.index('audit_log_target_idx').on(table.targetType, table.targetId)
	]
);
