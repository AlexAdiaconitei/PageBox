import { beforeAll, describe, expect, it } from 'vitest';
import { claimUpload } from '../../src/lib/server/deploy/upload-budget';
import { getConfig } from '../../src/lib/server/config';
import { writeFile, readdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import postgres from 'postgres';
import { join } from 'node:path';
import {
	configured,
	signIn,
	upload,
	buildZip,
	type Jar,
	base,
	adminHost,
	cookieHeader,
	hostHeader,
	post,
	actionResult,
	request,
	tag
} from './helpers';

function partialUpload(jar: Jar, archive: Uint8Array) {
	let finish: () => void;
	const result = new Promise<number>((resolve, reject) => {
		const req = httpRequest(
			`${base}/api/v1/sites/demo-api/deployments`,
			{
				method: 'POST',
				headers: {
					[hostHeader]: adminHost,
					origin: `http://${adminHost}`,
					cookie: cookieHeader(jar),
					'content-type': 'application/zip',
					'content-length': String(archive.length)
				}
			},
			(res) => {
				res.resume();
				res.on('end', () => {
					resolve(res.statusCode!);
					req.destroy();
				});
			}
		);
		req.on('error', reject);
		req.write(archive.slice(0, 20));
		finish = () => req.end(archive.slice(20));
	});
	return { result, finish: () => finish() };
}

(configured ? describe : describe.skip)('upload admission across processes', () => {
	let admin: Jar;
	beforeAll(async () => {
		if (process.env.PAGEBOX_DB_TESTS !== '1') throw new Error('Disposable database required');
		admin = await signIn();
	});
	it('bounds global capacity, releases claims, and removes an interrupted archive', async () => {
		const config = getConfig();
		const slots = Math.min(
			config.MAX_CONCURRENT_UPLOADS,
			Math.floor(config.MAX_UPLOAD_TEMP_BYTES / config.MAX_UPLOAD_BYTES)
		);
		const claims: Awaited<ReturnType<typeof claimUpload>>[] = [];
		try {
			for (let i = 0; i < slots; i++) claims.push(await claimUpload());
			await expect(claimUpload()).rejects.toMatchObject({ status: 503 });
			const refused = await upload('demo-api', buildZip({ 'index.html': 'busy' }), { jar: admin });
			expect(refused.status).toBe(503);
			const released = claims.pop()!;
			await writeFile(join(released.directory, 'upload.zip'), 'interrupted');
			await released.release();
			const accepted = await upload('demo-api', buildZip({ 'index.html': 'admitted' }), {
				jar: admin
			});
			expect(accepted.status).toBe(201);
			expect(await readdir(released.directory)).toEqual([]);
		} finally {
			for (const claim of claims) await claim.release();
		}
	}, 20000);
	it('aborts a stalled request and frees its global slot', async () => {
		expect(process.env.UPLOAD_BODY_TIMEOUT_SECONDS).toBe('10');
		const pending = partialUpload(admin, buildZip({ 'index.html': 'deadline' }));
		expect(await pending.result).toBe(408);
		expect(
			(await upload('demo-api', buildZip({ 'index.html': 'after-deadline' }), { jar: admin }))
				.status
		).toBe(201);
	}, 15000);
	it('refuses activation when a deployer loses permission while sending the body', async () => {
		const sql = postgres(process.env.DATABASE_URL_HOST ?? process.env.DATABASE_URL!, { max: 1 });
		try {
			const address = `slow-deployer-${tag()}@example.com`;
			const password = 'temporary-deployer-password';
			expect(
				(
					await actionResult(
						await post('/users?/create', admin, { email: address, password, role: 'user' })
					)
				).type
			).toBe('success');
			const [account] = await sql`select id from "user" where email = ${address}`;
			const deployer = await signIn({ email: address, password });
			await post('/account/password?/changePassword', deployer, {
				currentPassword: password,
				newPassword: 'chosen-deployer-password',
				confirm: 'chosen-deployer-password'
			});
			await post('/sites/demo-api?/addGrant', admin, {
				principal: `user:${account.id}`,
				role: 'deployer'
			});
			const before = await (
				await request('/api/v1/sites/demo-api/deployments', { jar: admin })
			).json();
			const pending = partialUpload(deployer, buildZip({ 'index.html': 'must-never-activate' }));
			let held = false;
			for (let i = 0; i < 50; i++) {
				const [lock] =
					await sql`select exists(select 1 from pg_locks where locktype='advisory' and classid=17842 and granted) as held`;
				if (lock.held) {
					held = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(held).toBe(true);
			const [grant] = await sql`select id from site_grant where principal_id = ${account.id}`;
			await post('/sites/demo-api?/removeGrant', admin, { grantId: grant.id });
			pending.finish();
			expect(await pending.result).toBe(403);
			const after = await (
				await request('/api/v1/sites/demo-api/deployments', { jar: admin })
			).json();
			expect(after.activeDeploymentId).toBe(before.activeDeploymentId);
			expect(after.deployments).toHaveLength(before.deployments.length);
		} finally {
			await sql.end();
		}
	}, 15000);
});
