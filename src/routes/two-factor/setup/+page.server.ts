import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { and, eq, ne } from 'drizzle-orm';
import QRCode from 'qrcode';
import type { Actions, PageServerLoad } from './$types';
import {
	callAuthEndpoint,
	refusedForCredentials,
	type CredentialResult
} from '$lib/server/auth/credentials';
import { loadSession } from '$lib/server/auth/session';
import {
	isTwoFactorRequired,
	twoFactorGate,
	twoFactorDestination
} from '$lib/server/auth/two-factor';
import { db } from '$lib/server/db';
import { withStorageLock } from '$lib/server/db/locks';
import { session, twoFactor } from '$lib/server/db/schema';
import { audit } from '$lib/server/audit';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(303, '/login?next=' + encodeURIComponent('/two-factor/setup'));
	const [pending] = await db
		.select({ verified: twoFactor.verified })
		.from(twoFactor)
		.where(eq(twoFactor.userId, locals.user.id))
		.limit(1);
	return {
		enabled: locals.user.twoFactorEnabled,
		required: await isTwoFactorRequired(),
		pending: pending?.verified === false,
		email: locals.user.email,
		hostKind: locals.hostKind,
		next: twoFactorDestination(url.searchParams.get('next'), locals.hostKind)
	};
};

function failure(result: CredentialResult) {
	return fail(result.rateLimited ? 429 : 400, {
		message: result.rateLimited
			? 'Too many attempts. Try again in a few minutes.'
			: refusedForCredentials(result)
				? 'The password is incorrect'
				: result.code === 'SESSION_NOT_FRESH'
					? 'Sign in again before changing your security settings.'
					: 'Could not update two-factor authentication. Check your code and try again.'
	});
}

async function revokeOtherSessions(event: RequestEvent, userId: string) {
	// Enrollment and disabling rotate the current session. Read the cookies set by the handler.
	const headers = new Headers(event.request.headers);
	headers.set(
		'cookie',
		event.cookies
			.getAll()
			.map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
			.join('; ')
	);
	const fresh = await loadSession(
		{ ...event, request: new Request(event.request.url, { headers }) },
		event.locals.hostKind,
		{ allowIncompleteTwoFactor: true }
	);
	if (!fresh || fresh.id !== userId || !event.locals.sessionId)
		throw new Error('Missing session after 2FA update');
	event.locals.user = fresh;
	await db
		.delete(session)
		.where(and(eq(session.userId, userId), ne(session.id, event.locals.sessionId)));
}

export const actions: Actions = {
	enable: async (event) => {
		if (event.locals.user!.twoFactorEnabled)
			return fail(400, { message: 'Two-factor authentication is already enabled' });
		const form = await event.request.formData();
		const result = await callAuthEndpoint(event, event.locals.hostKind, '/two-factor/enable', {
			password: String(form.get('password') ?? '')
		});
		if (!result.ok) return failure(result);
		const { totpURI, backupCodes } = result.body as { totpURI: string; backupCodes: string[] };
		return {
			enrollment: true,
			qr: await QRCode.toDataURL(totpURI, { width: 240, margin: 4 }),
			secret: new URL(totpURI).searchParams.get('secret'),
			backupCodes,
			message: 'Scan the QR code, save your recovery codes, then verify your authenticator.'
		};
	},
	verify: async (event) => {
		const current = event.locals.user!;
		if (current.twoFactorEnabled)
			return fail(400, { message: 'Two-factor authentication is already enabled' });
		const form = await event.request.formData();
		const code = String(form.get('code') ?? '').trim();
		if (!/^\d{6}$/.test(code) || form.get('saved') !== 'yes')
			return fail(400, {
				enrollment: true,
				message: 'Enter a 6-digit code and confirm you saved your recovery codes'
			});
		const result = await callAuthEndpoint(event, event.locals.hostKind, '/two-factor/verify-totp', {
			code,
			trustDevice: false
		});
		if (!result.ok) return failure(result);
		await revokeOtherSessions(event, current.id);
		await audit({ action: 'two_factor.enabled', actorUserId: current.id });
		// Keep the user on this screen to confirm activation and let them continue explicitly.
		return {
			ok: true,
			message: 'Two-factor authentication is enabled. Your other sessions have been signed out.'
		};
	},
	disable: async (event) => {
		if (await isTwoFactorRequired())
			return fail(403, { message: 'Two-factor authentication is required for every account' });
		const current = event.locals.user!;
		if (!current.twoFactorEnabled)
			return fail(400, { message: 'Two-factor authentication is not enabled' });
		const form = await event.request.formData();
		const result = await callAuthEndpoint(event, event.locals.hostKind, '/two-factor/disable', {
			password: String(form.get('password') ?? '')
		});
		if (!result.ok) return failure(result);
		await revokeOtherSessions(event, current.id);
		await audit({ action: 'two_factor.disabled', actorUserId: current.id });
		return {
			ok: true,
			message: 'Two-factor authentication is disabled. Your other sessions have been signed out.'
		};
	},
	regenerate: async (event) => {
		if (!event.locals.user!.twoFactorEnabled)
			return fail(400, { message: 'Enable two-factor authentication first' });
		const form = await event.request.formData();
		const result = await callAuthEndpoint(
			event,
			event.locals.hostKind,
			'/two-factor/generate-backup-codes',
			{ password: String(form.get('password') ?? '') }
		);
		if (!result.ok) return failure(result);
		await audit({ action: 'two_factor.recovery_regenerated', actorUserId: event.locals.user!.id });
		return {
			backupCodes: (result.body as { backupCodes: string[] }).backupCodes,
			message: 'Save these recovery codes. Your previous codes no longer work.'
		};
	}
};

for (const [name, action] of Object.entries(actions)) {
	if (action)
		actions[name] = (event) =>
			withStorageLock(async () => {
				event.locals.user = await loadSession(event, event.locals.hostKind, {
					allowIncompleteTwoFactor: true
				});
				if (!event.locals.user) redirect(303, '/login');
				const gate = twoFactorGate(
					event.locals.user.twoFactorEnabled,
					event.locals.twoFactorVerified,
					await isTwoFactorRequired()
				);
				if (gate === 'verify') redirect(303, '/two-factor');
				if (event.locals.hostKind === 'admin' && event.locals.user.mustChangePassword)
					redirect(303, '/account/password');
				return action(event);
			});
}
