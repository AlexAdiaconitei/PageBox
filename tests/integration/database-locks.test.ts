import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, getSql } from '../../src/lib/server/db';
import { withStorageLock } from '../../src/lib/server/db/locks';
import { deployment, site } from '../../src/lib/server/db/schema';
import { activate } from '../../src/lib/server/deploy/ingest';
import { deleteDeployment, deleteSite } from '../../src/lib/server/deploy/lifecycle';
import { sweepStaleUploads } from '../../src/lib/server/deploy/cleanup';
import { lookupSiteBySlug } from '../../src/lib/server/sites/resolve';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { newId } from '../../src/lib/server/ids';

const run = process.env.PAGEBOX_DB_TESTS === '1' ? describe : describe.skip;

run('database lock connection', () => {
	const fixtures: string[] = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const id of fixtures.splice(0)) await db.delete(site).where(eq(site.id, id));
	});
	afterAll(async () => {
		await getSql().end();
	});
	it('runs queries on the lock holder and supports nested transactions with a pool of one', async () => {
		await withStorageLock(async () => {
			const rows = await db.execute(
				sql`select exists(select 1 from pg_locks where pid = pg_backend_pid() and locktype = 'advisory' and granted) as held`
			);
			expect(rows[0].held).toBe(true);
			await db.transaction(async (tx) => {
				await tx.execute(sql`select 1`);
				await tx.transaction(async (nested) => {
					await nested.execute(sql`select 2`);
				});
			});
		});
	});
	it('serializes competing callbacks without starving their database queries', async () => {
		let active = 0;
		let maximum = 0;
		let completed = 0;
		await Promise.all(
			Array.from({ length: 12 }, () =>
				withStorageLock(async () => {
					active++;
					maximum = Math.max(maximum, active);
					await db.execute(sql`select pg_sleep(0.02)`);
					await withStorageLock(async () => {
						await db.execute(sql`select 1`);
					});
					active--;
					completed++;
				})
			)
		);
		expect(maximum).toBe(1);
		expect(completed).toBe(12);
	}, 15_000);
	it('releases a lock after callback failure', async () => {
		await expect(
			withStorageLock(async () => {
				throw new Error('fixture failure');
			})
		).rejects.toThrow('fixture failure');
		expect(await withStorageLock(async () => 'recovered')).toBe('recovered');
	});

	async function fixture() {
		const id = newId();
		const slug = `db-${id.toLowerCase()}`;
		fixtures.push(id);
		await db
			.insert(site)
			.values({ id, slug, name: slug, basePath: `/s/${slug}/`, visibility: 'private' });
		const a = newId();
		const b = newId();
		await db.insert(deployment).values([
			{ id: a, siteId: id, status: 'ready', totalBytes: 100 },
			{ id: b, siteId: id, status: 'ready', totalBytes: 500 }
		]);
		await db.update(site).set({ activeDeploymentId: a }).where(eq(site.id, id));
		return { ref: (await lookupSiteBySlug(slug))!, a, b };
	}

	it('protects the active row in both orders of concurrent activate and delete', async () => {
		for (const activateFirst of [true, false]) {
			const { ref, a, b } = await fixture();
			const outcomes = await Promise.allSettled(
				activateFirst
					? [activate(ref, b), deleteDeployment(ref.id, b)]
					: [deleteDeployment(ref.id, b), activate(ref, b)]
			);
			expect(outcomes[0].status).toBe('fulfilled');
			expect(outcomes[1].status).toBe('rejected');
			const current = (await lookupSiteBySlug(ref.slug))!;
			expect(current.activeDeploymentId).toBe(activateFirst ? b : a);
			const rows = await db
				.select()
				.from(deployment)
				.where(eq(deployment.id, current.activeDeploymentId!));
			expect(rows).toHaveLength(1);
		}
	});

	it('retains partial deletes, blocks activation and retries them through the sweeper', async () => {
		const { ref, b } = await fixture();
		const send = vi
			.spyOn(S3Client.prototype, 'send')
			.mockImplementation(async (command: unknown) =>
				command instanceof ListObjectsV2Command
					? { Contents: [{ Key: 'fixture/partial' }] }
					: { Errors: [{ Key: 'fixture/partial', Code: 'AccessDenied' }] }
			);
		await expect(deleteDeployment(ref.id, b)).rejects.toThrow('AccessDenied');
		const [pending] = await db.select().from(deployment).where(eq(deployment.id, b));
		expect(pending.status).toBe('deleting');
		expect(pending.totalBytes).toBe(500);
		await expect(activate(ref, b)).rejects.toMatchObject({ status: 409 });
		send.mockImplementation(async () => ({}));
		expect(await sweepStaleUploads()).toBeGreaterThanOrEqual(1);
		expect(await db.select().from(deployment).where(eq(deployment.id, b))).toHaveLength(0);
	});

	it('disables a partially deleted site and preserves the cleanup intent', async () => {
		const { ref } = await fixture();
		const send = vi
			.spyOn(S3Client.prototype, 'send')
			.mockImplementation(async (command: unknown) =>
				command instanceof ListObjectsV2Command
					? { Contents: [{ Key: 'fixture/partial' }] }
					: { Errors: [{ Key: 'fixture/partial', Code: 'AccessDenied' }] }
			);
		await expect(deleteSite(ref.id)).rejects.toThrow('AccessDenied');
		expect((await lookupSiteBySlug(ref.slug))?.disabled).toBe(true);
		const [pending] = await db.select().from(site).where(eq(site.id, ref.id));
		expect(pending.deletingAt).not.toBeNull();
		send.mockImplementation(async () => ({}));
		await sweepStaleUploads();
		expect(await lookupSiteBySlug(ref.slug)).toBeNull();
	});
});
