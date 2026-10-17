import { createHash, randomBytes } from 'node:crypto';
import { error, type RequestEvent } from '@sveltejs/kit';
import { and, count, eq, gt, lt } from 'drizzle-orm';
import { config, readerUrl, siteUrl } from '../config';
import { db } from '../db';
import { withLock } from '../db/locks';
import { session, site, siteAuthorization, siteSession, user } from '../db/schema';
import { newId } from '../ids';
import { atLeast, permissionFor } from '../perms';
import { lookupSiteBySlug, type SiteRef } from '../sites/resolve';
import type { SessionUser } from './index';
import { safeReaderDestination } from './destinations';
import { loadSession } from './session';
import { isTwoFactorRequired, twoFactorGate } from './two-factor';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const freshSecret = () => randomBytes(32).toString('base64url');
export const readerCookieName = () =>
	config.PAGEBOX_PUBLIC_SCHEME === 'https' ? '__Host-pb_site' : 'pb_site';

export function safeSiteDestination(
	value: string | null,
	ref: Pick<SiteRef, 'basePath' | 'hostname'>
): string {
	return safeReaderDestination(value, { origin: siteUrl(ref), basePath: ref.basePath });
}
export function accessUrl(ref: SiteRef, path: string): string {
	// Without a domain of its own the site shares the reader host, so its login is enough.
	if (!ref.hostname)
		return readerUrl('/login?next=' + encodeURIComponent(safeSiteDestination(path, ref)));
	return readerUrl(
		'/access?site=' +
			encodeURIComponent(ref.slug) +
			'&next=' +
			encodeURIComponent(safeSiteDestination(path, ref))
	);
}
function privateRedirect(location: string): Response {
	return new Response(null, {
		status: 302,
		headers: {
			location,
			'cache-control': 'private, no-store',
			'cdn-cache-control': 'no-store',
			'cloudflare-cdn-cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
			vary: 'Cookie'
		}
	});
}

export async function authorizeReader(event: RequestEvent): Promise<Response> {
	const current = await loadSession(event, 'sites');
	if (!current)
		return privateRedirect(
			'/login?next=' + encodeURIComponent(event.url.pathname + event.url.search)
		);
	const parentId = event.locals.sessionId!;
	// Reader login never waits for an upload's S3 operations on the storage lock.
	return withLock('reader-auth:' + parentId, async () => {
		const fresh = await loadSession(event, 'sites');
		if (!fresh || event.locals.sessionId !== parentId) error(404, 'Not found');
		const ref = await lookupSiteBySlug(event.url.searchParams.get('site') ?? '');
		if (
			!ref ||
			!ref.hostname ||
			ref.disabled ||
			!atLeast(await permissionFor(fresh, ref), 'viewer')
		)
			error(404, 'Not found');
		await db.delete(siteAuthorization).where(lt(siteAuthorization.expiresAt, new Date()));
		const [{ outstanding }] = await db
			.select({ outstanding: count() })
			.from(siteAuthorization)
			.where(eq(siteAuthorization.sessionId, parentId));
		if (outstanding >= 20) error(429, 'Too many pending site authorizations. Retry in a minute.');
		const code = freshSecret();
		await db.insert(siteAuthorization).values({
			codeHash: hash(code),
			siteId: ref.id,
			sessionId: parentId,
			nextPath: safeSiteDestination(event.url.searchParams.get('next'), ref),
			expiresAt: new Date(Date.now() + 30_000)
		});
		const target = new URL('/__pb/accept', siteUrl(ref));
		target.searchParams.set('code', code);
		return privateRedirect(target.href);
	});
}

export async function acceptReader(event: RequestEvent, siteId: string): Promise<Response> {
	const code = event.url.searchParams.get('code') ?? '';
	if (!/^[A-Za-z0-9_-]{43}$/.test(code)) error(404, 'Not found');
	// The reserved connection also carries transaction queries and permission reads.
	return withLock('reader-code:' + hash(code), async () =>
		db.transaction(async (tx) => {
			const [ref] = await tx.select().from(site).where(eq(site.id, siteId)).limit(1);
			if (!ref?.hostname || new URL(siteUrl(ref)).origin !== event.url.origin)
				error(404, 'Not found');
			const [authorization] = await tx
				.delete(siteAuthorization)
				.where(
					and(
						eq(siteAuthorization.codeHash, hash(code)),
						eq(siteAuthorization.siteId, siteId),
						gt(siteAuthorization.expiresAt, new Date())
					)
				)
				.returning();
			if (!authorization) error(404, 'Not found');
			const [parent] = await tx
				.select({ session, user })
				.from(session)
				.innerJoin(user, eq(user.id, session.userId))
				.where(
					and(
						eq(session.id, authorization.sessionId),
						eq(session.scope, 'view'),
						gt(session.expiresAt, new Date()),
						eq(user.banned, false)
					)
				)
				.limit(1);
			if (!parent) error(404, 'Not found');
			if (
				twoFactorGate(
					parent.user.twoFactorEnabled,
					parent.session.twoFactorVerified,
					await isTwoFactorRequired()
				)
			)
				error(404, 'Not found');
			const resolved = await lookupSiteBySlug(ref.slug);
			if (
				!resolved ||
				resolved.disabled ||
				!atLeast(await permissionFor(parent.user, resolved), 'viewer')
			)
				error(404, 'Not found');
			const token = freshSecret();
			const expiresAt = new Date(
				Math.min(parent.session.expiresAt.getTime(), Date.now() + 12 * 60 * 60 * 1000)
			);
			await tx
				.insert(siteSession)
				.values({
					id: newId(),
					tokenHash: hash(token),
					siteId,
					sessionId: parent.session.id,
					expiresAt
				})
				.onConflictDoUpdate({
					target: [siteSession.sessionId, siteSession.siteId],
					set: { tokenHash: hash(token), expiresAt }
				});
			const response = privateRedirect(safeSiteDestination(authorization.nextPath, resolved));
			// A response returned directly from handle bypasses resolve's cookie merging.
			response.headers.append(
				'set-cookie',
				event.cookies.serialize(readerCookieName(), token, {
					path: '/',
					httpOnly: true,
					secure: config.PAGEBOX_PUBLIC_SCHEME === 'https',
					sameSite: 'lax',
					expires: expiresAt
				})
			);
			return response;
		})
	);
}

export async function loadSiteSession(
	event: RequestEvent,
	siteId: string
): Promise<SessionUser | null> {
	const token = event.cookies.get(readerCookieName());
	if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
	const [row] = await db
		.select({ user, twoFactorVerified: session.twoFactorVerified })
		.from(siteSession)
		.innerJoin(session, eq(session.id, siteSession.sessionId))
		.innerJoin(user, eq(user.id, session.userId))
		.where(
			and(
				eq(siteSession.tokenHash, hash(token)),
				eq(siteSession.siteId, siteId),
				gt(siteSession.expiresAt, new Date()),
				gt(session.expiresAt, new Date()),
				eq(session.scope, 'view'),
				eq(user.banned, false)
			)
		)
		.limit(1);
	if (
		!row ||
		twoFactorGate(row.user.twoFactorEnabled, row.twoFactorVerified, await isTwoFactorRequired())
	)
		return null;
	return row.user;
}
