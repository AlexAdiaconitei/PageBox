import postgres from 'postgres';
import { error } from '@sveltejs/kit';
import { lstat, mkdir, readdir, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getConfig } from '../config';

let localClaims = 0;

/** Separate control connections keep slow bodies out of the application's DB pool. */
export async function claimUpload() {
	const config = getConfig();
	const slots = Math.min(
		config.MAX_CONCURRENT_UPLOADS,
		Math.floor(config.MAX_UPLOAD_TEMP_BYTES / config.MAX_UPLOAD_BYTES)
	);
	if (localClaims >= slots) error(503, 'Upload capacity is busy. Retry shortly.');
	localClaims++;
	const controller = new AbortController();
	let held = 0;
	let releasing = false;
	const control = postgres(config.DATABASE_URL, {
		max: 1,
		connect_timeout: 10,
		onnotice: () => {},
		onclose: () => {
			if (held && !releasing) controller.abort(new Error('Upload lock connection lost'));
		}
	});
	const release = async () => {
		releasing = true;
		try {
			if (held) await control`select pg_advisory_unlock(17842, ${held})`;
		} finally {
			try {
				await control.end({ timeout: 2 });
			} finally {
				localClaims--;
			}
		}
	};
	try {
		for (let slot = 1; slot <= slots; slot++) {
			const [row] = await control`select pg_try_advisory_lock(17842, ${slot}) as acquired`;
			if (row.acquired) {
				held = slot;
				break;
			}
		}
		if (!held) error(503, 'Upload capacity is busy. Retry shortly.');
		const root = resolve(process.env.PAGEBOX_TMP_DIR ?? tmpdir(), 'pagebox-uploads');
		await mkdir(root, { recursive: true, mode: 0o700 });
		if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink())
			throw new Error('Upload temporary root must be a real directory');
		const directory = join(root, `slot-${held}`);
		await mkdir(directory, { mode: 0o700 }).catch((err) => {
			if (err.code !== 'EEXIST') throw err;
		});
		if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
			throw new Error('Upload slot must be a real directory');
		// The global slot lock excludes live archives before removing crash leftovers.
		for (const entry of await readdir(directory)) {
			const target = resolve(directory, entry);
			if (target !== join(directory, 'upload.zip') || (await lstat(target)).isSymbolicLink())
				throw new Error('Unexpected file in upload slot');
			await rm(target);
		}
		const disk = await statfs(directory);
		if (disk.bavail * disk.bsize < config.MAX_UPLOAD_BYTES)
			error(503, 'Insufficient temporary disk space');
		const signal = AbortSignal.any([
			controller.signal,
			AbortSignal.timeout(config.UPLOAD_TIMEOUT_SECONDS * 1000)
		]);
		return { directory, signal, release };
	} catch (err) {
		await release();
		throw err;
	}
}
