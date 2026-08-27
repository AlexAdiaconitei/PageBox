import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/*
 * The same build has to answer on three different prefixes:
 *
 *   pnpm dev                       → /            (nothing set)
 *   GitHub Pages project site      → /PageBox     (DOCS_BASE_PATH=/PageBox)
 *   a PageBox site                 → /s/<slug>    (DOCS_BASE_PATH=/s/docs)
 *
 * so the prefix is read from the environment rather than written down. `basePath`
 * refuses a trailing slash, and PageBox reports its base path with one, so it is
 * trimmed here instead of in every caller.
 *
 * Everything else in this file exists because `output: 'export'` removes the server
 * that Next would otherwise put behind `/_next/image` — see content/docs/deploy/base-paths.mdx,
 * which documents this exact config for anyone deploying their own Next site.
 */
const basePath = (process.env.DOCS_BASE_PATH ?? '').replace(/\/$/, '');

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,

  // Emits `/docs/index.html` rather than `/docs.html`, which is what a plain file server
  // (GitHub Pages, PageBox) resolves without a rewrite rule.
  trailingSlash: true,

  basePath,
  // Required with `output: 'export'`: there is no optimiser to serve `/_next/image`.
  images: { unoptimized: true },

  // next/link takes basePath on its own. Nothing else does, so the one helper in
  // src/lib/base-path.ts reads it from here.
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default withMDX(config);
