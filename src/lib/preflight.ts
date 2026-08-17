/**
 * Checks run in the browser before a drag & drop upload leaves the machine.
 *
 * This is UX, not security — the server revalidates everything (docs/deploy-api.md), and
 * the client belongs to whoever is using it. What it buys is the difference between "your
 * site is broken" an hour later and "this build will not work under /s/<slug>/, here is
 * the line to change" before anything is uploaded.
 *
 * Pure on purpose: the DOM side (reading a dropped folder) lives in the component, the
 * rules live here where every one of them is a test.
 */

export type DroppedFile = { path: string; size: number };

export type WarningCode =
	| 'root-guessed'
	| 'missing-index'
	| 'absolute-paths'
	| 'base-path-ok'
	| 'generator-base-path'
	| 'too-many-files'
	| 'too-large'
	| 'excluded-junk';

export type Warning = {
	code: WarningCode;
	/** One line, in the interface's voice. */
	title: string;
	/** What to do about it, with the real value filled in where there is one. */
	detail: string;
	/** True when the build will not work as uploaded, rather than merely being untidy. */
	blocking: boolean;
};

/** Never uploaded: build output does not contain these, and a `.env` is a leak. */
export function isExcluded(path: string): boolean {
	if (/(^|\/)(node_modules|\.git)\//.test(path)) return true;
	if (/(^|\/)(\.DS_Store|Thumbs\.db)$/.test(path)) return true;
	if (/^__MACOSX\//.test(path)) return true;
	return path.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * The number one mistake: dropping the folder that *contains* the build instead of its
 * contents, so the site ends up one directory deep and every path is wrong.
 */
export function chooseRoot(paths: string[]): { root: string; guessed: boolean } {
	if (paths.length === 0) return { root: '', guessed: false };
	if (paths.some((path) => !path.includes('/'))) return { root: '', guessed: false };

	const tops = new Set(paths.map((path) => path.slice(0, path.indexOf('/'))));
	if (tops.size !== 1) return { root: '', guessed: false };

	const root = [...tops][0];
	return { root, guessed: true };
}

export function underRoot(paths: string[], root: string): string[] {
	if (!root) return paths;
	const prefix = root + '/';
	return paths.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
}

export type Generator = {
	id: 'next' | 'docusaurus' | 'astro' | 'vite' | 'sveltekit';
	label: string;
	/** The exact configuration to change, with this site's base path substituted. */
	fix: (basePath: string) => string;
};

const GENERATORS: Array<{
	id: Generator['id'];
	label: string;
	test: RegExp;
	fix: (b: string) => string;
}> = [
	{
		id: 'next',
		label: 'Next.js / Fumadocs',
		test: /(^|\/)_next\//,
		fix: (base) =>
			`next.config.js: basePath: '${base.replace(/\/$/, '')}' and assetPrefix: '${base.replace(/\/$/, '')}'`
	},
	{
		id: 'docusaurus',
		label: 'Docusaurus',
		test: /(^|\/)\.docusaurus\/|(^|\/)docusaurus\..*\.js$/,
		fix: (base) => `docusaurus.config.js: baseUrl: '${base}'`
	},
	{
		id: 'astro',
		label: 'Astro',
		test: /(^|\/)_astro\//,
		fix: (base) => `astro.config.mjs: base: '${base.replace(/\/$/, '')}'`
	},
	{
		id: 'sveltekit',
		label: 'SvelteKit',
		test: /(^|\/)_app\/immutable\//,
		fix: (base) => `svelte.config.js: kit.paths.base = '${base.replace(/\/$/, '')}'`
	},
	{
		id: 'vite',
		label: 'Vite',
		test: /(^|\/)assets\/index-[A-Za-z0-9_-]{6,}\.(js|css)$/,
		fix: (base) => `vite.config.ts: base: '${base}'`
	}
];

export function detectGenerator(paths: string[]): Generator | null {
	for (const generator of GENERATORS) {
		if (paths.some((path) => generator.test.test(path))) {
			return { id: generator.id, label: generator.label, fix: generator.fix };
		}
	}
	return null;
}

/**
 * References that start at the server root. Under `/s/<slug>/` they resolve outside the
 * site and 404 — this is the check that explains why a build "works locally".
 *
 * Protocol-relative (`//cdn…`) and data URLs are somebody else's problem, not ours.
 */
export function findAbsoluteReferences(html: string): string[] {
	const found = new Set<string>();
	const patterns = [
		/(?:src|href)\s*=\s*["'](\/[^/"'][^"']*)["']/gi,
		/url\(\s*["']?(\/[^/"')][^"')]*)["']?\s*\)/gi
	];

	for (const pattern of patterns) {
		for (const match of html.matchAll(pattern)) found.add(match[1]);
	}
	return [...found];
}

export type PreflightInput = {
	/** Every file the user dropped, with paths relative to what was dropped. */
	files: DroppedFile[];
	/** Contents of the HTML files, keyed by path under the chosen root. */
	htmlSamples: Record<string, string>;
	/** Where this site is served, e.g. `/s/docs-a/`. */
	basePath: string;
	limits: { maxFiles: number; maxBytes: number };
};

export type PreflightResult = {
	root: string;
	/** Paths relative to the root, junk removed — this is what gets zipped. */
	included: DroppedFile[];
	excluded: string[];
	totalBytes: number;
	generator: Generator | null;
	warnings: Warning[];
	/** True when nothing can be uploaded at all. */
	fatal: boolean;
};

export function preflight(input: PreflightInput): PreflightResult {
	const allPaths = input.files.map((file) => file.path);
	const { root, guessed } = chooseRoot(allPaths);

	const rebased = input.files
		.map((file) => ({
			path: root ? file.path.slice(root.length + 1) : file.path,
			size: file.size
		}))
		.filter((file) => file.path !== '');

	const included = rebased.filter((file) => !isExcluded(file.path));
	const excluded = rebased.filter((file) => isExcluded(file.path)).map((file) => file.path);
	const totalBytes = included.reduce((sum, file) => sum + file.size, 0);
	const paths = included.map((file) => file.path);
	const generator = detectGenerator(paths);

	const warnings: Warning[] = [];

	if (guessed) {
		warnings.push({
			code: 'root-guessed',
			title: `Uploading the contents of ${root}/`,
			detail:
				'Everything sat inside a single folder, so that folder is used as the site root. ' +
				'Otherwise the site would end up one directory deep and every path would be wrong.',
			blocking: false
		});
	}

	if (!paths.includes('index.html')) {
		warnings.push({
			code: 'missing-index',
			title: 'No index.html at the root',
			detail: `Nothing will answer at ${input.basePath} until there is one.`,
			blocking: true
		});
	}

	// A root-absolute reference is only wrong when it points *outside* this site. A build
	// configured with the right base path emits /s/<slug>/… everywhere, and calling that
	// broken is how a correct build gets told to fix itself.
	const absolute = new Set<string>();
	for (const html of Object.values(input.htmlSamples)) {
		for (const reference of findAbsoluteReferences(html)) absolute.add(reference);
	}
	const outside = [...absolute].filter((reference) => !reference.startsWith(input.basePath));
	const onBasePath = absolute.size - outside.length;

	if (outside.length > 0) {
		warnings.push({
			code: 'absolute-paths',
			title: 'This build points at the server root',
			detail:
				`References like ${outside.slice(0, 3).join(', ')} resolve outside ${input.basePath} ` +
				'and will 404. Rebuild with the base path below, or use relative paths.',
			blocking: true
		});

		if (generator) {
			warnings.push({
				code: 'generator-base-path',
				title: `${generator.label} build detected`,
				detail: generator.fix(input.basePath),
				blocking: false
			});
		}
	} else if (onBasePath > 0) {
		// Worth saying out loud: it is the check people most often get wrong, and knowing it
		// passed is the difference between deploying and second-guessing the config.
		warnings.push({
			code: 'base-path-ok',
			title: `Built for ${input.basePath}`,
			detail: `${onBasePath} reference(s) already point at this site's base path.`,
			blocking: false
		});
	}

	if (included.length > input.limits.maxFiles) {
		warnings.push({
			code: 'too-many-files',
			title: `${included.length} files is over the limit`,
			detail: `This instance accepts ${input.limits.maxFiles} files per deployment.`,
			blocking: true
		});
	}

	if (totalBytes > input.limits.maxBytes) {
		warnings.push({
			code: 'too-large',
			title: `${formatBytes(totalBytes)} is too big to send from the browser`,
			detail: `The limit here is ${formatBytes(input.limits.maxBytes)}. Deploy this one from CI with a token.`,
			blocking: true
		});
	}

	if (excluded.length > 0) {
		warnings.push({
			code: 'excluded-junk',
			title: `${excluded.length} file(s) left out`,
			detail: `Dotfiles, .git and node_modules are never uploaded: ${excluded.slice(0, 3).join(', ')}${excluded.length > 3 ? '…' : ''}`,
			blocking: false
		});
	}

	return {
		root,
		included,
		excluded,
		totalBytes,
		generator,
		warnings,
		fatal: included.length === 0
	};
}

export function formatBytes(n: number): string {
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = n;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${Math.round(value * 10) / 10} ${units[unit]}`;
}
