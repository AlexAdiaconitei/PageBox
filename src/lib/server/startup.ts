import { hashPassword } from 'better-auth/crypto';
import { count, eq } from 'drizzle-orm';
import { config } from './config';
import { db, getSql } from './db';
import { runMigrations } from './db/migrate';
import { account, user } from './db/schema';
import { newId } from './ids';
import { ensureBucket } from './s3';
import { cache } from './cache';
import { startSweeper } from './deploy/cleanup';

/**
 * Everything that must be true before the first request is served.
 *
 * It runs inside the process instead of a separate release step because both targets —
 * Dokploy (Application) and `docker compose up` — start the container and nothing else.
 * Every task is idempotent, and any failure kills the process: a half-migrated PageBox
 * serving traffic is worse than a container that restarts.
 */
export async function startup(): Promise<void> {
	const t0 = Date.now();
	try {
		if (config.PAGEBOX_MIGRATE_ON_START) {
			await runMigrations();
			log('migrations applied');
		}

		if (config.PAGEBOX_ENSURE_BUCKET_ON_START) {
			const state = await ensureBucket();
			log(`bucket "${config.S3_BUCKET}" ${state}`);
		}

		await bootstrapAdmin();

		// Sweeps deployments whose upload died mid-flight, now and once an hour.
		startSweeper();

		log(
			`ready in ${Date.now() - t0}ms · admin=${config.PAGEBOX_ADMIN_HOST} ` +
				`sites=${config.PAGEBOX_SITES_HOST}${config.PAGEBOX_SITES_PREFIX}/<slug>/ ` +
				`cache=${cache.kind} upload-cap=${config.maxUploadLabel}`
		);
	} catch (err) {
		console.error('[pagebox] startup failed:', err);
		await getSql()
			.end({ timeout: 5 })
			.catch(() => {});
		process.exit(1);
	}
}

/**
 * Creates the first superadmin when the instance is empty. Never touches an existing
 * user: once someone can log in, these env vars are inert.
 */
async function bootstrapAdmin(): Promise<void> {
	if (!config.BOOTSTRAP_ADMIN_EMAIL || !config.BOOTSTRAP_ADMIN_PASSWORD) return;

	const [{ value: users }] = await db.select({ value: count() }).from(user);
	if (users > 0) return;

	const email = config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
	const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
	if (existing.length) return;

	const id = newId();
	const hash = await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD);

	await db.transaction(async (tx) => {
		await tx.insert(user).values({
			id,
			email,
			name: 'Superadmin',
			emailVerified: true,
			role: 'superadmin',
			// The password came from an env var, which lives in a deployment UI and in
			// somebody's shell history. It is a first-login credential, not a password.
			mustChangePassword: true
		});
		await tx.insert(account).values({
			id: newId(),
			accountId: id,
			providerId: 'credential',
			userId: id,
			password: hash
		});
	});

	log(`bootstrap superadmin created: ${email} (must change password at first login)`);
}

function log(msg: string): void {
	console.log(`[pagebox] ${msg}`);
}
