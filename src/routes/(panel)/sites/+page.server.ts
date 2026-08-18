import { fail, redirect } from '@sveltejs/kit';
import { eq, inArray } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { audit } from '$lib/server/audit';
import { basePathFor, config, siteUrl } from '$lib/server/config';
import { db } from '$lib/server/db';
import { deployment, site } from '$lib/server/db/schema';
import { isValidSlug, newId } from '$lib/server/ids';
import { sitesForUser } from '$lib/server/perms';

export const load: PageServerLoad = async ({ locals, url }) => {
	const sites = await sitesForUser(locals.user!);

	// What is actually being served right now: the list answers "is it up", but "when did
	// it last change" and "how big is it" are the next two questions an operator asks, and
	// both live on the deployment each site points at. One query for the whole page.
	const liveIds = sites.map((entry) => entry.activeDeploymentId).filter((id) => id !== null);
	const liveRows = liveIds.length
		? await db
				.select({
					id: deployment.id,
					createdAt: deployment.createdAt,
					fileCount: deployment.fileCount,
					totalBytes: deployment.totalBytes
				})
				.from(deployment)
				.where(inArray(deployment.id, liveIds))
		: [];
	const liveById = new Map(liveRows.map((row) => [row.id, row]));

	return {
		sites: sites.map((entry) => {
			const live = entry.activeDeploymentId ? liveById.get(entry.activeDeploymentId) : undefined;
			return {
				...entry,
				url: siteUrl(entry.basePath, url.port),
				liveAt: live?.createdAt ?? null,
				liveFileCount: live?.fileCount ?? null,
				liveBytes: live?.totalBytes ?? null
			};
		}),
		sitesHost: config.PAGEBOX_SITES_HOST,
		sitesPrefix: config.PAGEBOX_SITES_PREFIX,
		canCreate: locals.user!.role === 'superadmin'
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		// Creating a site claims a slug on a shared hostname, so it stays with superadmins
		// until there is a reason to delegate it.
		if (locals.user!.role !== 'superadmin') return fail(403, { slug: '', message: 'Not allowed' });

		const data = await request.formData();
		const slug = String(data.get('slug') ?? '')
			.trim()
			.toLowerCase();
		const name = String(data.get('name') ?? '').trim() || slug;
		const visibility = data.get('visibility') === 'public' ? 'public' : 'private';
		const spaFallback = data.get('spaFallback') === 'on';

		if (!isValidSlug(slug)) {
			return fail(400, {
				slug,
				message: 'Slugs are 2–41 characters: lowercase letters, digits and dashes'
			});
		}

		const [existing] = await db.select({ id: site.id }).from(site).where(eq(site.slug, slug));
		if (existing) return fail(409, { slug, message: `The slug "${slug}" is taken` });

		const id = newId();
		await db.insert(site).values({
			id,
			slug,
			name,
			visibility,
			basePath: basePathFor(slug),
			spaFallback,
			ownerUserId: locals.user!.id
		});

		await audit({
			action: 'site.created',
			actorUserId: locals.user!.id,
			targetType: 'site',
			targetId: id,
			meta: { slug, visibility }
		});

		redirect(303, `/sites/${slug}`);
	}
};
