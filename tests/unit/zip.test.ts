import { describe, expect, it } from 'vitest';
import { isSymlinkEntry, safeEntryPath, ZipRejected } from '../../src/lib/server/deploy/zip';

describe('safeEntryPath', () => {
	it('keeps ordinary entries', () => {
		expect(safeEntryPath('index.html')).toBe('index.html');
		expect(safeEntryPath('./assets/app.js')).toBe('assets/app.js');
		expect(safeEntryPath('a//b/c.css')).toBe('a/b/c.css');
	});

	it('treats backslashes as separators', () => {
		expect(safeEntryPath('assets\\app.js')).toBe('assets/app.js');
	});

	it('skips directories and archive junk', () => {
		expect(safeEntryPath('assets/')).toBeNull();
		expect(safeEntryPath('__MACOSX/._index.html')).toBeNull();
		expect(safeEntryPath('nested/.DS_Store')).toBeNull();
		expect(safeEntryPath('')).toBeNull();
	});

	// Zip-slip: yauzl hands these over untouched, the caller is the only guard.
	it('rejects traversal and absolute paths', () => {
		for (const name of [
			'../../etc/passwd',
			'a/../../b',
			'/etc/passwd',
			'C:/Windows/system32/x.dll',
			'..\\..\\evil.txt'
		]) {
			expect(() => safeEntryPath(name), name).toThrow(ZipRejected);
		}
	});

	it('reports zip-slip as its own reason', () => {
		try {
			safeEntryPath('../evil');
			expect.unreachable();
		} catch (err) {
			expect((err as ZipRejected).reason).toBe('zip-slip');
		}
	});
});

describe('isSymlinkEntry', () => {
	const attrs = (mode: number) => mode << 16;

	it('spots a unix symlink', () => {
		expect(isSymlinkEntry(attrs(0o120777))).toBe(true);
	});

	it('leaves regular files and directories alone', () => {
		expect(isSymlinkEntry(attrs(0o100644))).toBe(false);
		expect(isSymlinkEntry(attrs(0o040755))).toBe(false);
		expect(isSymlinkEntry(0)).toBe(false); // zips written on Windows
	});
});
