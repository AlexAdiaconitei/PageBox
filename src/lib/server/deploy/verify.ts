import { eq } from 'drizzle-orm';
import { db } from '../db';
import { deployment } from '../db/schema';
import { getObject, headObject, objectKey } from '../s3';
import { normaliseSubpath } from '../sites/paths';
import type { SiteRef } from '../sites/resolve';

/**
 * Reads the deployment's own index.html and checks that the files it names are there.
 *
 * This is what turns "we warned you that this build points at the server root" into "3 of
 * its assets are missing": a fact, recorded on the deployment, instead of a caveat nobody
 * reads. It looks straight at S3 rather than fetching over HTTP — no session to arrange,
 * and a private site is checked the same way as a public one.
 */

const MAX_CHECKED = 25;

export type Verification = { checked: number; brokenAssetCount: number; broken: string[] };

export async function verifyDeployment(input: {
	siteRef: SiteRef;
	deploymentId: string;
}): Promise<Verification | null> {
	const indexKey = objectKey(input.siteRef.id, input.deploymentId, 'index.html');
	const head = await headObject(indexKey);
	if (!head) return null;

	const html = await readIndex(indexKey);
	if (html === null) return null;

	const references = localReferences(html).slice(0, MAX_CHECKED);
	const broken: string[] = [];

	for (const reference of references) {
		const path = resolveAgainstRoot(reference, input.siteRef.basePath);
		if (path === null) continue;
		const found = await headObject(objectKey(input.siteRef.id, input.deploymentId, path));
		if (!found) broken.push(reference);
	}

	await db
		.update(deployment)
		.set({ brokenAssetCount: broken.length })
		.where(eq(deployment.id, input.deploymentId))
		.catch(() => {});

	return { checked: references.length, brokenAssetCount: broken.length, broken };
}

async function readIndex(key: string): Promise<string | null> {
	const object = await getObject(key);
	if (!object) return null;

	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of object.body) {
		chunks.push(chunk as Buffer);
		size += (chunk as Buffer).length;
		// An index.html past this is not one we can learn anything more from.
		if (size > 2 * 1024 * 1024) break;
	}
	return Buffer.concat(chunks).toString('utf8');
}

/** References to files this deployment should contain, ignoring anything off-site. */
export function localReferences(html: string): string[] {
	const found = new Set<string>();
	const patterns = [/(?:src|href)\s*=\s*["']([^"']+)["']/gi, /url\(\s*["']?([^"')]+)["']?\s*\)/gi];

	for (const pattern of patterns) {
		for (const match of html.matchAll(pattern)) {
			const reference = match[1].trim();
			if (!reference || reference.startsWith('#')) continue;
			if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) continue; // http:, data:, mailto:
			if (reference.startsWith('//')) continue; // protocol-relative
			found.add(reference.split('#')[0].split('?')[0]);
		}
	}
	return [...found].filter(Boolean);
}

/**
 * Turns a reference in the served page into a path inside the deployment.
 *
 * Root-absolute references only belong to this site when they start with its base path —
 * which is exactly what the preflight warns about when they do not.
 */
export function resolveAgainstRoot(reference: string, basePath: string): string | null {
	if (reference.startsWith('/')) {
		if (!reference.startsWith(basePath)) return null;
		return normaliseSubpath(reference.slice(basePath.length));
	}
	return normaliseSubpath(reference);
}
