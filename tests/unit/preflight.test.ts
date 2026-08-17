import { describe, expect, it } from 'vitest';
import {
	chooseRoot,
	detectGenerator,
	findAbsoluteReferences,
	isExcluded,
	preflight
} from '../../src/lib/preflight';

const file = (path: string, size = 100) => ({ path, size });
const limits = { maxFiles: 20000, maxBytes: 100 * 1024 * 1024 };
const run = (files: { path: string; size: number }[], htmlSamples: Record<string, string> = {}) =>
	preflight({ files, htmlSamples, basePath: '/s/docs-a/', limits });

describe('chooseRoot', () => {
	// The number one mistake: dropping the folder that contains the build.
	it('uses the single top-level folder as the root', () => {
		expect(chooseRoot(['dist/index.html', 'dist/assets/app.js'])).toEqual({
			root: 'dist',
			guessed: true
		});
	});

	it('leaves the root alone when files sit at the top', () => {
		expect(chooseRoot(['index.html', 'assets/app.js'])).toEqual({ root: '', guessed: false });
	});

	it('leaves the root alone when there are several top-level folders', () => {
		expect(chooseRoot(['a/index.html', 'b/app.js'])).toEqual({ root: '', guessed: false });
	});
});

describe('isExcluded', () => {
	it('drops dotfiles, git, node_modules and OS junk', () => {
		expect(isExcluded('.env')).toBe(true);
		expect(isExcluded('.git/config')).toBe(true);
		expect(isExcluded('node_modules/react/index.js')).toBe(true);
		expect(isExcluded('assets/.DS_Store')).toBe(true);
		expect(isExcluded('__MACOSX/._index.html')).toBe(true);
	});

	it('keeps ordinary build output', () => {
		expect(isExcluded('index.html')).toBe(false);
		expect(isExcluded('_next/static/chunk.js')).toBe(false);
	});
});

describe('findAbsoluteReferences', () => {
	// Root-absolute references are why a build "works locally" and 404s under /s/<slug>/.
	it('finds root-absolute src, href and url()', () => {
		const html = `<link href="/style.css"><script src="/app.js"></script>
			<style>body{background:url(/bg.png)}</style>`;
		expect(findAbsoluteReferences(html).sort()).toEqual(['/app.js', '/bg.png', '/style.css']);
	});

	it('ignores relative, protocol-relative and absolute URLs', () => {
		const html = `<img src="img/a.png"><script src="//cdn.example.com/x.js"></script>
			<a href="https://example.com">x</a><img src="data:image/png;base64,AA">`;
		expect(findAbsoluteReferences(html)).toEqual([]);
	});
});

describe('detectGenerator', () => {
	it('names the generator and the exact line to change', () => {
		expect(detectGenerator(['_next/static/x.js'])?.fix('/s/docs-a/')).toContain(
			"basePath: '/s/docs-a'"
		);
		expect(detectGenerator(['_astro/index.css'])?.id).toBe('astro');
		expect(detectGenerator(['_app/immutable/x.js'])?.id).toBe('sveltekit');
		expect(detectGenerator(['assets/index-D5WKCSAV.js'])?.id).toBe('vite');
		expect(detectGenerator(['index.html'])).toBeNull();
	});
});

describe('preflight', () => {
	it('accepts a clean build with no warnings', () => {
		const result = run([file('index.html'), file('style.css')], {
			'index.html': '<link href="style.css">'
		});
		expect(result.warnings).toEqual([]);
		expect(result.included).toHaveLength(2);
		expect(result.fatal).toBe(false);
	});

	it('rebases onto the guessed root and says so', () => {
		const result = run([file('dist/index.html'), file('dist/app.js')]);
		expect(result.root).toBe('dist');
		expect(result.included.map((f) => f.path)).toEqual(['index.html', 'app.js']);
		expect(result.warnings.map((w) => w.code)).toContain('root-guessed');
	});

	it('blocks on a missing index.html', () => {
		const result = run([file('about.html')]);
		const warning = result.warnings.find((w) => w.code === 'missing-index');
		expect(warning?.blocking).toBe(true);
		expect(warning?.detail).toContain('/s/docs-a/');
	});

	it('blocks on root-absolute references and shows them', () => {
		const result = run([file('index.html')], { 'index.html': '<script src="/app.js"></script>' });
		const warning = result.warnings.find((w) => w.code === 'absolute-paths');
		expect(warning?.blocking).toBe(true);
		expect(warning?.detail).toContain('/app.js');
	});

	it('excludes junk instead of uploading it', () => {
		const result = run([file('index.html'), file('.env'), file('node_modules/x/index.js')]);
		expect(result.included.map((f) => f.path)).toEqual(['index.html']);
		expect(result.warnings.map((w) => w.code)).toContain('excluded-junk');
	});

	it('refuses uploads over the caps', () => {
		const big = preflight({
			files: [file('index.html', 200 * 1024 * 1024)],
			htmlSamples: {},
			basePath: '/s/docs-a/',
			limits
		});
		expect(big.warnings.find((w) => w.code === 'too-large')?.blocking).toBe(true);
	});
});
