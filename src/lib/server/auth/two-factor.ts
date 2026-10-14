import { eq } from 'drizzle-orm';
import { db } from '../db';
import { securityPolicy } from '../db/schema';
import { safeLoginDestination } from './destinations';
import { adminUrl, config, type HostKind } from '../config';

export function authenticatorUri(value: string): string {
	const uri = new URL(value);
	uri.searchParams.set('image', adminUrl('/icon-192.png'));
	return uri.href;
}

export function twoFactorDestination(value: string | null, kind: HostKind): string {
	const next = safeLoginDestination(value, kind, config.PAGEBOX_SITES_PREFIX);
	return new URL(next, 'https://login.invalid').pathname.startsWith('/two-factor') ? '/' : next;
}

export async function isTwoFactorRequired(): Promise<boolean> {
	const [policy] = await db
		.select()
		.from(securityPolicy)
		.where(eq(securityPolicy.id, 'instance'))
		.limit(1);
	return policy?.requireTwoFactor ?? false;
}

export function twoFactorGate(
	enabled: boolean,
	verified: boolean,
	required: boolean
): 'verify' | 'setup' | null {
	if (enabled && !verified) return 'verify';
	if (required && !enabled) return 'setup';
	return null;
}
