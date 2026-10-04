import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { withStorageLock } from '../db/locks';
import { apikey, deployment, site } from '../db/schema';
import { deletePrefix, deploymentPrefix, sitePrefix } from '../s3';
import { invalidateSite } from '../sites/resolve';

export async function deleteDeployment(siteId: string, id: string): Promise<void> {
	return withStorageLock(async () => {
		const [current] = await db.select().from(site).where(eq(site.id, siteId)).limit(1);
		const [row] = await db
			.select()
			.from(deployment)
			.where(and(eq(deployment.id, id), eq(deployment.siteId, siteId)))
			.limit(1);
		if (!current || !row) error(404, 'Deployment not found');
		if (current.activeDeploymentId === id)
			error(409, 'Activate another deployment before deleting this one');
		if (row.status === 'uploading') error(409, 'An upload in progress cannot be deleted');
		await db.update(deployment).set({ status: 'deleting' }).where(eq(deployment.id, id));
		await deletePrefix(deploymentPrefix(siteId, id));
		await db.delete(deployment).where(eq(deployment.id, id));
	});
}

export async function deleteSite(siteId: string): Promise<number> {
	return withStorageLock(async () => {
		const [current] = await db.select().from(site).where(eq(site.id, siteId)).limit(1);
		if (!current) error(404, 'Site not found');
		// Persist the intent before touching S3. A crash or partial deletion remains retryable.
		await db.update(site).set({ deletingAt: new Date() }).where(eq(site.id, siteId));
		await invalidateSite(current.slug, siteId);
		await deletePrefix(sitePrefix(siteId));
		const keys = await db
			.delete(apikey)
			.where(eq(apikey.siteId, siteId))
			.returning({ id: apikey.id });
		await db.delete(site).where(eq(site.id, siteId));
		return keys.length;
	});
}
