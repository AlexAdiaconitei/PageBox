/**
 * How each generator is told what path it will be served under.
 *
 * This is the same table PageBox ships in `src/lib/preflight.ts`, where it feeds both the
 * preflight warning in the drop area and the deploy recipe on the site page. It is
 * reproduced here so the documentation and the panel cannot say different things about
 * the same option — if you change one, change the other.
 *
 * The slash conventions differ per tool and are not guessable. They were read off the
 * official documentation, which is what `docs` links to, and they are the whole reason
 * this is a table rather than a sentence:
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

export type Recipe = {
  id: string;
  label: string;
  /** Tools built on it that take the same option, named so people find themselves. */
  aka?: string;
  /** The file to edit. */
  file: string;
  /** The option, written the way it appears in that file. */
  option: string;
  /** The language to highlight the snippet as. */
  lang: string;
  /** The value that option takes for this site. Every tool disagrees about the slashes. */
  value: (site: SiteTarget) => string;
  /** What to paste in, with this site's own path already substituted. */
  snippet: (site: SiteTarget) => string;
  /** What produces the build. */
  build: string;
  /** Where the build lands — the directory to zip. */
  output: string;
  /** What the option prefixes on its own. The things nobody has to touch. */
  handled: string;
  /** What it does not prefix, and the helper that does. */
  manual?: { what: string; helper: string };
  /** Official documentation for this exact option. Checked August 2026. */
  docs: string;
  /** Where else the official documentation is worth reading for a static deployment. */
  furtherReading?: { text: string; href: string }[];
  /** Filenames that give the generator away in an uploaded build, where it has a tell. */
  detectable: string | null;
};

/** `/s/docs/` → `/s/docs`, for the tools that refuse a trailing slash. */
const noTrailing = (basePath: string) => basePath.replace(/\/$/, '');

export const RECIPES: Recipe[] = [
  {
    id: 'next',
    label: 'Next.js',
    aka: 'Fumadocs, Nextra',
    file: 'next.config.mjs',
    option: 'basePath',
    lang: 'js',
    value: (site) => noTrailing(site.basePath),
    snippet: (site) => `/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  trailingSlash: true,

  basePath: '${noTrailing(site.basePath)}',
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: '${noTrailing(site.basePath)}' },
};

export default config;`,
    build: 'next build',
    output: 'out',
    docs: 'https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath',
    furtherReading: [
      {
        text: 'Static Exports — what an export does and does not support',
        href: 'https://nextjs.org/docs/app/guides/static-exports',
      },
      {
        text: 'images.unoptimized',
        href: 'https://nextjs.org/docs/app/api-reference/components/image#unoptimized',
      },
    ],
    handled: 'next/link, _next/static, and images imported through the bundler',
    manual: {
      what: 'next/image with a literal src, metadata.icons, and anything in public/ written as an absolute path',
      helper: 'a withBasePath() helper reading process.env.NEXT_PUBLIC_BASE_PATH',
    },
    detectable: '_next/',
  },
  {
    id: 'docusaurus',
    label: 'Docusaurus',
    file: 'docusaurus.config.js',
    option: 'baseUrl',
    lang: 'js',
    value: (site) => site.basePath,
    snippet: (site) => `export default {
  url: '${site.url.replace(/\/s\/.*$/, '')}',
  baseUrl: '${site.basePath}',
};`,
    build: 'npm run build',
    output: 'build',
    docs: 'https://docusaurus.io/docs/api/docusaurus-config#baseUrl',
    furtherReading: [
      { text: 'Static assets — how Docusaurus resolves them', href: 'https://docusaurus.io/docs/static-assets' },
      { text: 'useBaseUrl()', href: 'https://docusaurus.io/docs/docusaurus-core#usebaseurl' },
    ],
    handled: 'markdown links, and <Link to="…"> in React',
    manual: {
      what: 'assets that are not links — a raw <img src="/img/x.png">',
      helper: "useBaseUrl(), or better require('@site/static/img/x.png')",
    },
    detectable: '.docusaurus/',
  },
  {
    id: 'astro',
    label: 'Astro',
    aka: 'Starlight',
    file: 'astro.config.mjs',
    option: 'base',
    lang: 'js',
    value: (site) => noTrailing(site.basePath),
    snippet: (site) => `import { defineConfig } from 'astro/config';

export default defineConfig({
  site: '${site.url.replace(/\/s\/.*$/, '')}',
  base: '${noTrailing(site.basePath)}',
});`,
    build: 'npm run build',
    output: 'dist',
    docs: 'https://docs.astro.build/en/reference/configuration-reference/#base',
    furtherReading: [
      {
        text: 'import.meta.env.BASE_URL',
        href: 'https://docs.astro.build/en/guides/environment-variables/#default-environment-variables',
      },
      { text: 'Static assets in public/', href: 'https://docs.astro.build/en/basics/project-structure/#public' },
    ],
    handled: 'the _astro/ bundle output, and nothing else',
    manual: {
      what: 'every <a href> and every public/ asset written as an absolute path',
      helper: 'import.meta.env.BASE_URL',
    },
    detectable: '_astro/',
  },
  {
    id: 'vitepress',
    label: 'VitePress',
    file: '.vitepress/config.ts',
    option: 'base',
    lang: 'ts',
    value: (site) => site.basePath,
    snippet: (site) => `import { defineConfig } from 'vitepress';

export default defineConfig({
  base: '${site.basePath}',
});`,
    build: 'npm run docs:build',
    output: '.vitepress/dist',
    docs: 'https://vitepress.dev/reference/site-config#base',
    furtherReading: [
      { text: 'withBase()', href: 'https://vitepress.dev/reference/runtime-api#usedata' },
      { text: 'Deploying a VitePress site', href: 'https://vitepress.dev/guide/deploy' },
    ],
    handled: 'markdown links and the theme’s own navigation',
    manual: {
      what: 'asset paths written literally in a component or in frontmatter',
      helper: "withBase() from 'vitepress'",
    },
    detectable: null,
  },
  {
    id: 'sveltekit',
    label: 'SvelteKit',
    file: 'svelte.config.js',
    option: 'kit.paths.base',
    lang: 'js',
    value: (site) => noTrailing(site.basePath),
    snippet: (site) => `import adapter from '@sveltejs/adapter-static';

export default {
  kit: {
    adapter: adapter(),
    paths: { base: '${noTrailing(site.basePath)}' },
  },
};`,
    build: 'npm run build',
    output: 'build',
    docs: 'https://svelte.dev/docs/kit/configuration#paths',
    furtherReading: [
      { text: 'adapter-static', href: 'https://svelte.dev/docs/kit/adapter-static' },
      { text: '$app/paths — resolve()', href: 'https://svelte.dev/docs/kit/$app-paths' },
    ],
    handled: 'the _app/immutable/ bundle output',
    manual: {
      what: 'your own hrefs and asset paths',
      helper: "resolve() from '$app/paths' (base is deprecated)",
    },
    detectable: '_app/immutable/',
  },
  {
    id: 'vite',
    label: 'Vite',
    aka: 'React, Vue, Svelte SPAs',
    file: 'vite.config.ts',
    option: 'base',
    lang: 'ts',
    value: (site) => site.basePath,
    snippet: (site) => `import { defineConfig } from 'vite';

export default defineConfig({
  base: '${site.basePath}',
});`,
    build: 'npm run build',
    output: 'dist',
    docs: 'https://vite.dev/config/shared-options.html#base',
    furtherReading: [
      { text: 'Public base path', href: 'https://vite.dev/guide/build.html#public-base-path' },
      { text: 'import.meta.env.BASE_URL', href: 'https://vite.dev/guide/env-and-mode.html' },
    ],
    handled: 'imported assets, CSS url() references, and paths written in .html',
    manual: {
      what: 'a public/ path built at runtime rather than written literally',
      helper: 'import.meta.env.BASE_URL',
    },
    detectable: 'assets/index-<hash>.js',
  },
  {
    id: 'nuxt',
    label: 'Nuxt',
    file: 'nuxt.config.ts',
    option: 'app.baseURL',
    lang: 'ts',
    value: (site) => site.basePath,
    snippet: (site) => `export default defineNuxtConfig({
  app: { baseURL: '${site.basePath}' },
});`,
    build: 'npx nuxt generate',
    output: '.output/public',
    docs: 'https://nuxt.com/docs/api/nuxt-config',
    furtherReading: [
      { text: 'Static hosting — nuxt generate', href: 'https://nuxt.com/docs/getting-started/deployment#static-hosting' },
      { text: 'useRuntimeConfig()', href: 'https://nuxt.com/docs/api/composables/use-runtime-config' },
    ],
    handled: 'the built bundle under the configured baseURL',
    manual: {
      what: 'paths you assemble yourself, and public/ assets written absolutely',
      helper: 'useRuntimeConfig().app.baseURL',
    },
    detectable: null,
  },
  {
    id: 'hugo',
    label: 'Hugo',
    file: 'hugo.toml',
    option: 'baseURL',
    lang: 'toml',
    value: (site) => site.url,
    snippet: (site) => `baseURL = '${site.url}'`,
    build: 'hugo --minify',
    output: 'public',
    docs: 'https://gohugo.io/configuration/all/',
    furtherReading: [
      { text: 'relURL', href: 'https://gohugo.io/functions/urls/relurl/' },
      { text: 'Host and deploy', href: 'https://gohugo.io/host-and-deploy/' },
    ],
    handled: 'anything built with the URL functions',
    manual: {
      what: 'paths written with a leading slash in a template',
      helper: 'relURL — the docs advise omitting the leading slash',
    },
    detectable: null,
  },
];

export function getRecipe(id: string): Recipe {
  const recipe = RECIPES.find((entry) => entry.id === id);
  if (!recipe) throw new Error(`No deploy recipe for "${id}"`);
  return recipe;
}
