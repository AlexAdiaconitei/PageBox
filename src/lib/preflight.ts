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
import { formatBytes } from '$lib/format';

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

/**
 * How each generator is told what path it will be served under.
 *
 * One table, two consumers: the preflight warning in the drop area, and the deploy recipe on
 * the site page. They used to be able to disagree — the warning said one thing and the
 * copyable instructions said another — and a site that 404s every asset is exactly the wrong
 * place to have two opinions.
 *
 * The slash conventions differ per tool and are not guessable. They were read off the
 * official documentation, which is what `docs` links to, and they are the whole reason this
 * is a table rather than a sentence:
 *
 *   trailing slash required   Docusaurus, VitePress, Vite, Nuxt
 *   no trailing slash         Next.js, Astro, SvelteKit
 *   a full absolute URL       Hugo
 */
export type SiteTarget = {
	/** `/s/<slug>/` — always with both slashes, as PageBox stores it. */
	basePath: string;
	/** `https://pages.example.com/s/<slug>/` — the address the site answers on. */
	url: string;
};

export type GeneratorRecipe = {
	id: string;
	label: string;
	/** Tools built on it that take the same option, named so people find themselves. */
	aka?: string;
	/** The file to edit. */
	file: string;
	/** The option, written the way it appears in that file. */
	option: string;
	/**
	 * The value that option takes for this site — the whole point of the table, since every
	 * tool disagrees about the slashes. `snippet` embeds it and the preflight warning prints
	 * it, so the two can only ever say the same thing.
	 */
	value: (site: SiteTarget) => string;
	/** What to paste in, with this site's own path already substituted. */
	snippet: (site: SiteTarget) => string;
	/** What produces the build. */
	build: string;
	/** Where the build lands — the directory to zip. */
	output: string;
	/** What the option prefixes on its own. The things nobody has to touch. */
	handled: string;
	/**
	 * What it does *not* prefix, and the helper that does.
	 *
	 * Setting the base path is necessary and not sufficient in every one of these tools, and
	 * each draws the line somewhere else — Vite rewrites almost everything, Astro rewrites
	 * almost nothing. The gap is where a site half-works: pages navigate, images 404. That is
	 * the half that costs an afternoon, so it belongs beside the config that causes it.
	 */
	manual?: { what: string; helper: string };
	/** Official docs for this exact option. Checked August 2026. */
	docs: string;
	/** Filenames that give the generator away in an uploaded build, where it has a tell. */
	test?: RegExp;
};

/** `/s/docs/` → `/s/docs`, for the tools that refuse a trailing slash. */
const noTrailing = (basePath: string) => basePath.replace(/\/$/, '');

export const GENERATOR_RECIPES: GeneratorRecipe[] = [
	{
		id: 'next',
		label: 'Next.js',
		aka: 'Fumadocs, Nextra',
		file: 'next.config.js',
		option: 'basePath',
		value: (site) => noTrailing(site.basePath),
		/*
		 * Six lines, and five of them are not `basePath`.
		 *
		 * `output: 'export'` because a Next app that has not been told to export produces a
		 * server build, which is not a thing PageBox can host. `images.unoptimized` because a
		 * static export has no optimiser behind `/_next/image`, so without it every
		 * `next/image` emits a URL that 404s — the snippet here used to omit it and was
		 * therefore wrong. And `NEXT_PUBLIC_BASE_PATH` because the helper below has to read
		 * the prefix from somewhere, and one definition beats a literal repeated across a
		 * dozen components.
		 */
		snippet: (site) =>
			`const basePath = '${noTrailing(site.basePath)}';\n\nmodule.exports = {\n  output: 'export',\n  trailingSlash: true,\n  basePath,\n  images: { unoptimized: true },\n  env: { NEXT_PUBLIC_BASE_PATH: basePath }\n};`,
		build: 'next build',
		output: 'out',
		docs: 'https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath',
		handled: 'next/link, _next/static, and images imported through the bundler',
		manual: {
			what: 'next/image with a literal src, metadata.icons, and anything in public/ written as an absolute path',
			helper: 'a withBasePath() helper reading process.env.NEXT_PUBLIC_BASE_PATH'
		},
		test: /(^|\/)_next\//
	},
	{
		id: 'docusaurus',
		label: 'Docusaurus',
		file: 'docusaurus.config.js',
		option: 'baseUrl',
		value: (site) => site.basePath,
		// Both slashes: Docusaurus documents baseUrl as '/metro/', and drops assets if either
		// one is missing.
		snippet: (site) => `export default {\n  baseUrl: '${site.basePath}'\n};`,
		build: 'npm run build',
		output: 'build',
		docs: 'https://docusaurus.io/docs/api/docusaurus-config#baseUrl',
		handled: 'markdown links, and <Link to="…"> in React',
		manual: {
			what: 'assets that are not links — a raw <img src="/img/x.png">',
			helper: "useBaseUrl(), or better require('@site/static/img/x.png')"
		},
		test: /(^|\/)\.docusaurus\/|(^|\/)docusaurus\..*\.js$/
	},
	{
		id: 'astro',
		label: 'Astro',
		aka: 'Starlight',
		file: 'astro.config.mjs',
		option: 'base',
		value: (site) => noTrailing(site.basePath),
		snippet: (site) =>
			`import { defineConfig } from 'astro/config';\n\nexport default defineConfig({\n  base: '${noTrailing(site.basePath)}'\n});`,
		build: 'npm run build',
		output: 'dist',
		docs: 'https://docs.astro.build/en/reference/configuration-reference/#base',
		// The strictest of the set: `base` tells the bundler where the site will live and
		// rewrites nothing else. Every href and every public/ path is the author's to prefix.
		handled: 'the _astro/ bundle output, and nothing else',
		manual: {
			what: 'every <a href> and every public/ asset written as an absolute path',
			helper: 'import.meta.env.BASE_URL'
		},
		test: /(^|\/)_astro\//
	},
	{
		id: 'vitepress',
		label: 'VitePress',
		file: '.vitepress/config.ts',
		option: 'base',
		value: (site) => site.basePath,
		// "It should always start and end with a slash" — the VitePress docs, verbatim.
		snippet: (site) =>
			`import { defineConfig } from 'vitepress';\n\nexport default defineConfig({\n  base: '${site.basePath}'\n});`,
		build: 'npm run docs:build',
		output: '.vitepress/dist',
		docs: 'https://vitepress.dev/reference/site-config#base',
		handled: 'markdown links and the theme’s own navigation',
		manual: {
			what: 'asset paths written literally in a component or in frontmatter',
			helper: "withBase() from 'vitepress'"
		}
	},
	{
		id: 'sveltekit',
		label: 'SvelteKit',
		file: 'svelte.config.js',
		option: 'kit.paths.base',
		value: (site) => noTrailing(site.basePath),
		// Static output needs the adapter *and* the base; either alone gives a site that
		// half works, which is worse than one that plainly does not.
		snippet: (site) =>
			`import adapter from '@sveltejs/adapter-static';\n\nexport default {\n  kit: {\n    adapter: adapter(),\n    paths: { base: '${noTrailing(site.basePath)}' }\n  }\n};`,
		build: 'npm run build',
		output: 'build',
		docs: 'https://svelte.dev/docs/kit/configuration#paths',
		handled: 'the _app/immutable/ bundle output',
		manual: {
			what: 'your own hrefs and asset paths',
			// `base` still exists and still works, but the docs now point at resolve() — worth
			// naming which one, because the deprecated answer is the one most guides give.
			helper: "resolve() from '$app/paths' (base is deprecated)"
		},
		test: /(^|\/)_app\/immutable\//
	},
	{
		id: 'vite',
		label: 'Vite',
		aka: 'React, Vue, Svelte SPAs',
		file: 'vite.config.ts',
		option: 'base',
		value: (site) => site.basePath,
		snippet: (site) =>
			`import { defineConfig } from 'vite';\n\nexport default defineConfig({\n  base: '${site.basePath}'\n});`,
		build: 'npm run build',
		output: 'dist',
		docs: 'https://vite.dev/config/shared-options.html#base',
		// The best-behaved of the set: imported assets, CSS url() and references in .html are
		// all rewritten at build time. Only a path assembled at runtime is left alone.
		handled: 'imported assets, CSS url() references, and paths written in .html',
		manual: {
			what: 'a public/ path built at runtime rather than written literally',
			helper: 'import.meta.env.BASE_URL'
		},
		test: /(^|\/)assets\/index-[A-Za-z0-9_-]{6,}\.(js|css)$/
	},
	{
		id: 'nuxt',
		label: 'Nuxt',
		file: 'nuxt.config.ts',
		option: 'app.baseURL',
		value: (site) => site.basePath,
		// `nuxt generate`, not `nuxt build`: the latter produces a server.
		snippet: (site) =>
			`export default defineNuxtConfig({\n  app: { baseURL: '${site.basePath}' }\n});`,
		build: 'npx nuxt generate',
		output: '.output/public',
		docs: 'https://nuxt.com/docs/api/nuxt-config',
		handled: 'the built bundle under the configured baseURL',
		manual: {
			what: 'paths you assemble yourself, and public/ assets written absolutely',
			helper: 'useRuntimeConfig().app.baseURL'
		}
	},
	{
		id: 'hugo',
		label: 'Hugo',
		file: 'hugo.toml',
		option: 'baseURL',
		value: (site) => site.url,
		// The odd one out: Hugo wants the whole address, scheme and all, not a path — so this
		// is the only recipe that needs to know the site's URL rather than its base path.
		snippet: (site) => `baseURL = '${site.url}'`,
		build: 'hugo --minify',
		output: 'public',
		docs: 'https://gohugo.io/configuration/all/',
		// Hugo takes a whole URL and hands you functions rather than rewriting anything: a
		// leading-slash path in a template stays exactly as written.
		handled: 'anything built with the URL functions',
		manual: {
			what: 'paths written with a leading slash in a template',
			helper: 'relURL — the docs advise omitting the leading slash'
		}
	}
];

export type Generator = {
	id: string;
	label: string;
	/** The exact configuration to change, with this site's base path substituted. */
	fix: (basePath: string) => string;
};

/**
 * Which generator produced this build, from the filenames it left behind.
 *
 * Only the ones with an unmistakable tell are detectable — `_next/`, `_astro/`,
 * `_app/immutable/`. Hugo and VitePress produce ordinary directories with nothing in them
 * that says who made them, so they appear in the recipe tabs and never here. Guessing wrong
 * is worse than not guessing: the warning would name a config file the person does not have.
 */
export function detectGenerator(paths: string[]): Generator | null {
	for (const recipe of GENERATOR_RECIPES) {
		if (!recipe.test || !paths.some((path) => recipe.test!.test(path))) continue;
		return {
			id: recipe.id,
			label: recipe.label,
			// The same string the recipe tab shows, so the warning and the instructions can
			// never name different options.
			fix: (basePath) =>
				`${recipe.file}: ${recipe.option}: '${recipe.value({ basePath, url: basePath })}'`
		};
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
