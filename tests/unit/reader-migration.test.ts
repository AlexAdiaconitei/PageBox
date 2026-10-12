import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../../src/lib/server/db/schema';

let previous: ReturnType<typeof generateDrizzleJson>;
let current: ReturnType<typeof generateDrizzleJson>;
let statements: string[];

beforeAll(async () => {
	previous = JSON.parse(await readFile('drizzle/meta/0008_snapshot.json', 'utf8'));
	current = generateDrizzleJson(schema, previous.id);
	statements = await generateMigration(previous, current);
});

describe('reader session migration', () => {
	it('adds only the reader authorization and per-site session tables', () => {
		const additions = Object.keys(current.tables)
			.filter((name) => !(name in previous.tables))
			.sort();
		expect(additions).toEqual(['public.site_authorization', 'public.site_session']);
		for (const [name, definition] of Object.entries(previous.tables))
			expect(current.tables[name], name).toEqual(definition);
		expect(statements.some((sql) => /DROP TABLE|DROP COLUMN/i.test(sql))).toBe(false);
		expect(statements.filter((sql) => sql.startsWith('CREATE TABLE'))).toHaveLength(2);
	});
	it('revokes reader sessions and pending codes when their parent session or site is deleted', () => {
		for (const name of ['public.site_authorization', 'public.site_session']) {
			const foreignKeys = Object.values(current.tables[name].foreignKeys) as {
				tableTo: string;
				onDelete: string;
			}[];
			expect(foreignKeys.map((fk) => fk.tableTo).sort()).toEqual(['session', 'site']);
			expect(foreignKeys.every((fk) => fk.onDelete === 'cascade')).toBe(true);
		}
		const indexes = current.tables['public.site_session'].indexes;
		expect(indexes.site_session_parent_site_key.isUnique).toBe(true);
		expect(indexes.site_session_token_key.isUnique).toBe(true);
	});

	it('matches the installed SQL, snapshot and migration journal', async () => {
		const installedSql = await readFile('drizzle/0009_site_reader_sessions.sql', 'utf8');
		const generatedSql =
			statements.join('--> statement-breakpoint' + String.fromCharCode(10)) +
			String.fromCharCode(10);
		expect(installedSql).toEqual(generatedSql);
		const installed = JSON.parse(await readFile('drizzle/meta/0009_snapshot.json', 'utf8'));
		expect(installed.tables).toEqual(current.tables);
		expect(installed.prevId).toBe(previous.id);
		const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'));
		expect(journal.entries.at(-1)).toMatchObject({
			idx: 9,
			version: '7',
			tag: '0009_site_reader_sessions',
			breakpoints: true
		});
		expect(journal.entries.at(-1).when).toBeGreaterThan(journal.entries.at(-2).when);
	});
});
