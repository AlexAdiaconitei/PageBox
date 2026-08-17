import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { chooseRoot } from '$lib/preflight';
import { objectKey, putObject } from '../s3';
import { contentTypeFor } from '../sites/mime';

/**
 * Zip extraction straight into S3, with the guards from §6.4 of the design brief.
 *
 * Every limit is checked *while* reading, never at the end: a zip bomb that is only
 * detected after decompression has already cost the disk and the memory it was aimed at.
 */

export type ZipLimits = {
	maxFiles: number;
	maxUncompressedBytes: number;
	/** Uncompressed:compressed ratio above which the archive is treated as a bomb. */
	maxRatio: number;
};

export type ZipResult = {
	fileCount: number;
	totalBytes: number;
	/** Entries deliberately not stored: junk and dotfiles. Directories are not entries. */
	skipped: string[];
	/** Directory the archive was rebased onto, '' when it was already at the root. */
	root: string;
};

export class ZipRejected extends Error {
	constructor(
		message: string,
		readonly reason:
			'zip-slip' | 'symlink' | 'too-many-files' | 'too-large' | 'ratio' | 'empty' | 'unreadable'
	) {
		super(message);
		this.name = 'ZipRejected';
	}
}

/** Entries never worth storing, whatever they contain. */
const JUNK = [/^__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/];

/**
 * Normalises an archive entry name to a path inside the deployment.
 *
 * Returns null for entries that must be skipped (directories, junk) and throws for
 * entries that mean the archive is hostile. yauzl does not do any of this for you:
 * `validateEntrySizes` checks sizes, not names.
 */
export function safeEntryPath(rawName: string): string | null {
	if (rawName.length === 0) return null;

	// Windows-built archives can carry backslashes; treat them as separators.
	const name = rawName.replace(/\\/g, '/');

	if (name.endsWith('/')) return null; // directory entry
	if (JUNK.some((pattern) => pattern.test(name))) return null;

	if (name.startsWith('/') || /^[a-zA-Z]:\//.test(name)) {
		throw new ZipRejected(`absolute path in archive: ${rawName}`, 'zip-slip');
	}

	const parts: string[] = [];
	for (const segment of name.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			// Even when it would stay inside the prefix after normalisation, a '..' in an
			// archive is a crafted archive.
			throw new ZipRejected(`path traversal in archive: ${rawName}`, 'zip-slip');
		}
		parts.push(segment);
	}
	if (parts.length === 0) return null;
	return parts.join('/');
}

/** Unix mode from the external attributes; symlinks must never be stored or followed. */
export function isSymlinkEntry(externalFileAttributes: number): boolean {
	const mode = (externalFileAttributes >>> 16) & 0xffff;
	return (mode & 0xf000) === 0xa000;
}

/** Buffer small entries (the common case) and stream the rare large one. */
const BUFFER_LIMIT = 16 * 1024 * 1024;

export async function extractZipToS3(
	zipPath: string,
	target: { siteId: string; deploymentId: string },
	limits: ZipLimits
): Promise<ZipResult> {
	// `zip -r site.zip out` is the obvious command and puts every path under `out/`, which
	// would deploy a site whose root holds one directory and no index.html. The browser
	// already rebases a dropped folder; the API has to do the same or the friendliest
	// possible mistake produces a site that 404s and says nothing about why.
	const root = chooseRoot(await listEntryPaths(zipPath)).root;

	const zip = await openZip(zipPath);
	const result: ZipResult = { fileCount: 0, totalBytes: 0, skipped: [], root };
	let compressedTotal = 0;

	try {
		for await (const entry of entries(zip)) {
			const path = rebase(safeEntryPath(entry.fileName), root);
			if (path === null) {
				// Directory entries are not files and saying they were "skipped" reads like
				// something went wrong.
				if (!entry.fileName.endsWith('/')) result.skipped.push(entry.fileName);
				continue;
			}
			if (isSymlinkEntry(entry.externalFileAttributes)) {
				throw new ZipRejected(`symlink in archive: ${entry.fileName}`, 'symlink');
			}

			if (result.fileCount + 1 > limits.maxFiles) {
				throw new ZipRejected(`archive holds more than ${limits.maxFiles} files`, 'too-many-files');
			}
			if (result.totalBytes + entry.uncompressedSize > limits.maxUncompressedBytes) {
				throw new ZipRejected(
					`archive expands past ${limits.maxUncompressedBytes} bytes`,
					'too-large'
				);
			}

			compressedTotal += entry.compressedSize;
			// Ignore the ratio for tiny archives, where a few hundred bytes of headers
			// against a highly compressible file is not evidence of anything.
			if (
				compressedTotal > 4096 &&
				result.totalBytes + entry.uncompressedSize > compressedTotal * limits.maxRatio
			) {
				throw new ZipRejected(
					`compression ratio above ${limits.maxRatio}:1 — treated as a zip bomb`,
					'ratio'
				);
			}

			const stream = await openEntry(zip, entry);
			const key = objectKey(target.siteId, target.deploymentId, path);
			const contentType = contentTypeFor(path);

			if (entry.uncompressedSize <= BUFFER_LIMIT) {
				const body = await readAll(stream, entry.uncompressedSize);
				await putObject(key, body, { contentType, contentLength: body.length });
				result.totalBytes += body.length;
			} else {
				await putObject(key, stream, {
					contentType,
					contentLength: entry.uncompressedSize
				});
				result.totalBytes += entry.uncompressedSize;
			}
			result.fileCount += 1;
		}
	} finally {
		zip.close();
	}

	if (result.fileCount === 0) throw new ZipRejected('archive contains no files', 'empty');
	return result;
}

/** Entry names only: the central directory is read, no file data. */
async function listEntryPaths(zipPath: string): Promise<string[]> {
	const zip = await openZip(zipPath);
	const paths: string[] = [];
	try {
		for await (const entry of entries(zip)) {
			const path = safeEntryPath(entry.fileName);
			if (path !== null) paths.push(path);
		}
	} finally {
		zip.close();
	}
	return paths;
}

function rebase(path: string | null, root: string): string | null {
	if (path === null || root === '') return path;
	const prefix = root + '/';
	return path.startsWith(prefix) ? path.slice(prefix.length) || null : null;
}

function openZip(path: string): Promise<ZipFile> {
	return new Promise((resolve, reject) => {
		yauzl.open(
			path,
			// validateEntrySizes makes yauzl itself error when the actual bytes disagree
			// with the central directory, which is what makes the size accounting above
			// trustworthy.
			{ lazyEntries: true, autoClose: false, validateEntrySizes: true },
			(err, zipfile) => {
				if (err || !zipfile) {
					reject(new ZipRejected(`not a readable zip archive: ${err?.message}`, 'unreadable'));
					return;
				}
				resolve(zipfile);
			}
		);
	});
}

type NextEntry =
	{ type: 'entry'; entry: Entry } | { type: 'end' } | { type: 'error'; error: Error };

/** Async iteration over a lazyEntries zipfile: one `readEntry()` per pull. */
async function* entries(zip: ZipFile): AsyncGenerator<Entry> {
	let pending: ((value: NextEntry) => void) | null = null;
	const settle = (value: NextEntry) => {
		const resolve = pending;
		pending = null;
		resolve?.(value);
	};

	zip.on('entry', (entry: Entry) => settle({ type: 'entry', entry }));
	zip.on('end', () => settle({ type: 'end' }));
	zip.on('error', (error: Error) => settle({ type: 'error', error }));

	for (;;) {
		const next = await new Promise<NextEntry>((resolve) => {
			pending = resolve;
			zip.readEntry();
		});
		if (next.type === 'end') return;
		if (next.type === 'error') {
			// yauzl rejects `../` entries itself, before we ever see the name. Report that
			// as what it is instead of burying it under "corrupt archive"; safeEntryPath
			// still covers the shapes yauzl lets through (backslashes, drive letters).
			if (/invalid relative path|absolute path/i.test(next.error.message)) {
				throw new ZipRejected(next.error.message, 'zip-slip');
			}
			throw new ZipRejected(`corrupt archive: ${next.error.message}`, 'unreadable');
		}
		yield next.entry;
	}
}

function openEntry(zip: ZipFile, entry: Entry): Promise<Readable> {
	return new Promise((resolve, reject) => {
		zip.openReadStream(entry, (err, stream) => {
			if (err || !stream) {
				reject(
					new ZipRejected(`unreadable entry ${entry.fileName}: ${err?.message}`, 'unreadable')
				);
				return;
			}
			resolve(stream);
		});
	});
}

async function readAll(stream: Readable, expected: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	await pipeline(stream, async function (source) {
		for await (const chunk of source) {
			size += (chunk as Buffer).length;
			if (size > expected) {
				throw new ZipRejected('entry is larger than its declared size', 'ratio');
			}
			chunks.push(chunk as Buffer);
		}
	});
	return Buffer.concat(chunks);
}
