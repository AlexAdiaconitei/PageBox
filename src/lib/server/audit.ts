import { db } from './db';
import { auditLog } from './db/schema';
import { newId } from './ids';

/**
 * Append-only trail of who did what. Never throws: an audit write failing must not turn a
 * successful deploy into a 500, but it must be loud in the logs.
 */
export type AuditEntry = {
	action: string;
	actorUserId?: string | null;
	actorTokenId?: string | null;
	targetType?: string | null;
	targetId?: string | null;
	meta?: Record<string, unknown> | null;
	ip?: string | null;
};

export async function audit(entry: AuditEntry): Promise<void> {
	try {
		await db.insert(auditLog).values({
			id: newId(),
			action: entry.action,
			actorUserId: entry.actorUserId ?? null,
			actorTokenId: entry.actorTokenId ?? null,
			targetType: entry.targetType ?? null,
			targetId: entry.targetId ?? null,
			meta: entry.meta ?? null,
			ip: entry.ip ?? null
		});
	} catch (err) {
		console.error(`[pagebox] audit write failed for "${entry.action}":`, err);
	}
}
