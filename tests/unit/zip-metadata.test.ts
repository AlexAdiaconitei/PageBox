import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { measureZip } from '../../src/lib/server/deploy/zip';

const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true });
});
async function archive(files: Record<string, string>) {
	const dir = await mkdtemp(join(tmpdir(), 'pagebox-zip-test-'));
	directories.push(dir);
	const path = join(dir, 'fixture.zip');
	await writeFile(
		path,
		zipSync(
			Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])),
			{ level: 0 }
		)
	);
	return path;
}

describe('ZIP metadata validation', () => {
	it('chooses the public root after filtering hidden directories', async () => {
		const path = await archive({
			'out/index.html': 'hello',
			'.git/config': 'secret',
			'out/.env': 'secret'
		});
		expect(await measureZip(path)).toEqual({ fileCount: 1, totalBytes: 5, root: 'out' });
	});
	it('refuses a ZIP holding only hidden files', async () => {
		await expect(
			measureZip(await archive({ '.git/config': 'secret', '.git/HEAD': 'secret' }))
		).rejects.toMatchObject({ reason: 'empty' });
	});
	it('bounds the directory before allocating all paths', async () => {
		const path = await archive({ 'index.html': 'a', 'a.txt': 'b', 'b.txt': 'c' });
		await expect(
			measureZip(path, { maxFiles: 2, maxUncompressedBytes: 100, maxRatio: 100 })
		).rejects.toMatchObject({ reason: 'too-many-files' });
	});
	it('refuses oversized declared contents before writing objects', async () => {
		const path = await archive({ 'index.html': 'a'.repeat(11) });
		await expect(
			measureZip(path, { maxFiles: 2, maxUncompressedBytes: 10, maxRatio: 100 })
		).rejects.toMatchObject({ reason: 'too-large' });
	});
});
