import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import postgres from 'postgres';
import {
	configured,
	signIn,
	post,
	actionResult,
	request,
	tag,
	sitesHost,
	type Jar
} from './helpers';

(configured ? describe : describe.skip)('account recovery transaction', () => {
	let sql: ReturnType<typeof postgres>;
	let admin: Jar;
	beforeAll(async () => {
		if (process.env.PAGEBOX_DB_TESTS !== '1') throw new Error('Disposable database required');
		sql = postgres(process.env.DATABASE_URL_HOST ?? process.env.DATABASE_URL!, { max: 2 });
		admin = await signIn();
	});
	afterAll(async () => {
		await sql?.end();
	});
	const recover = (email: string, keep = false) =>
		new Promise<number>((resolve) => {
			execFile(
				process.execPath,
				[
					'scripts/set-password.mjs',
					'--email',
					email,
					'--password',
					'recovered-fixture-password',
					...(keep ? ['--keep'] : [])
				],
				{ env: process.env, windowsHide: true },
				(error) => resolve(error ? Number(error.code) : 0)
			);
		});
	it('revokes reader and panel sessions and records an atomic reset', async () => {
		const email = `recovery-${tag()}@example.com`;
		expect(
			(
				await actionResult(
					await post('/users?/create', admin, {
						email,
						password: 'original-fixture-password',
						role: 'user'
					})
				)
			).type
		).toBe('success');
		const panel = await signIn({ email, password: 'original-fixture-password' });
		const reader = await signIn({ email, password: 'original-fixture-password' }, sitesHost);
		expect(panel.size).toBeGreaterThan(0);
		expect(reader.size).toBeGreaterThan(0);
		expect(await recover(email)).toBe(0);
		const [row] = await sql`select id, must_change_password from "user" where email = ${email}`;
		expect(row.must_change_password).toBe(true);
		expect(await sql`select id from session where user_id = ${row.id}`).toHaveLength(0);
		expect((await request('/api/v1/whoami', { jar: panel })).status).toBe(401);
		expect((await signIn({ email, password: 'original-fixture-password' })).size).toBe(0);
		expect((await signIn({ email, password: 'recovered-fixture-password' })).size).toBeGreaterThan(
			0
		);
		const [audit] =
			await sql`select meta from audit_log where target_id = ${row.id} and action = 'user.password_reset' order by created_at desc limit 1`;
		expect(audit.meta.source).toBe('recovery-script');
		expect(audit.meta.sessionsRevoked).toBe(2);
	}, 20000);
	it('rolls the password, flag and session revocation back if audit insertion fails', async () => {
		const email = `rollback-${tag()}@example.com`;
		await post('/users?/create', admin, {
			email,
			password: 'original-fixture-password',
			role: 'user'
		});
		await signIn({ email, password: 'original-fixture-password' });
		const [before] =
			await sql`select u.id, u.must_change_password, a.password from "user" u join account a on a.user_id=u.id where u.email=${email}`;
		await sql.unsafe(
			`create function fixture_reject_recovery() returns trigger language plpgsql as $$ begin if new.meta->>'source' = 'recovery-script' then raise exception 'fixture audit failure'; end if; return new; end $$`
		);
		await sql.unsafe(
			'create trigger fixture_reject_recovery before insert on audit_log for each row execute function fixture_reject_recovery()'
		);
		try {
			expect(await recover(email, true)).toBe(1);
			const [after] =
				await sql`select u.id, u.must_change_password, a.password from "user" u join account a on a.user_id=u.id where u.email=${email}`;
			expect(after).toEqual(before);
			expect(await sql`select id from session where user_id=${before.id}`).toHaveLength(1);
		} finally {
			await sql.unsafe('drop trigger fixture_reject_recovery on audit_log');
			await sql.unsafe('drop function fixture_reject_recovery()');
		}
	}, 20000);
});
