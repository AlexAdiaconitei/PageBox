import { getSql } from './db';
import { headObject } from './s3';

/**
 * Liveness of the two hard dependencies. Results are cached for a few seconds so that
 * probes every 5–30s do not turn into constant load on Postgres and S3.
 */

export type Health = { ok: boolean; db: boolean; s3: boolean };

let last: (Health & { at: number }) | null = null;
const TTL_MS = 5000;

export async function probeHealth(): Promise<Health> {
	if (last && Date.now() - last.at < TTL_MS) return last;

	const [db, s3] = await Promise.all([
		getSql()`select 1`.then(
			() => true,
			() => false
		),
		// HEAD on a key that need not exist: a 404 answer still proves the endpoint,
		// credentials and bucket routing work.
		headObject('__pb/health').then(
			() => true,
			() => false
		)
	]);

	last = { ok: db && s3, db, s3, at: Date.now() };
	return last;
}
