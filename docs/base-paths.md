# Base paths: what each generator does not prefix

A PageBox site is served under `/s/<slug>/`, never at a domain root. Every static site
generator has an option for that, and **in all of them the option is necessary and not
sufficient** — each one prefixes some things automatically and leaves the rest to you.

The gap is where a site half-works: pages navigate fine, images 404, the favicon is missing.
That failure is invisible locally, because locally the base path is `/`.

The panel's deploy recipe carries the short version of this per generator. Below is the
reasoning, and the one worked example — Next.js — that is long enough to need one.

---

## The shape of the problem

| Generator | Prefixed for you | Yours to wrap |
| --------- | ---------------- | ------------- |
| Next.js | `next/link`, `_next/static`, bundler-imported images | `next/image` with a literal `src`, `metadata.icons`, `public/` paths |
| Docusaurus | markdown links, `<Link to>` | raw `<img src="/img/x.png">` |
| Astro | the `_astro/` bundle, and nothing else | every `<a href>`, every `public/` asset |
| VitePress | markdown links, theme navigation | literal asset paths in components or frontmatter |
| SvelteKit | `_app/immutable/` | your own hrefs and asset paths |
| Vite | imported assets, CSS `url()`, paths in `.html` | a `public/` path assembled at runtime |
| Nuxt | the built bundle | paths you assemble, `public/` assets written absolutely |
| Hugo | anything built with the URL functions | any leading-slash path in a template |

The helper each one gives you is in the panel, on the tab for that generator, with this
site's own value already substituted. What follows is why the Next.js case in particular
takes more than one line.

---

## Next.js (and Fumadocs, Nextra) {#next}

`next/link` applies `basePath` for navigation. `next/image` **does not** apply it to `src`.
With `output: 'export'` there is also no server behind `/_next/image`, so the optimiser
cannot run. Set only `basePath` and you get a site whose pages work and whose images,
favicon and any other `public/` asset all 404.

### 1. `next.config.mjs`

```js
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

const basePath = '/s/mi-app'; // the real subpath, no trailing slash

/** @type {import('next').NextConfig} */
const config = {
	reactStrictMode: true,
	output: 'export', // fully static build
	trailingSlash: true, // recommended for static hosting

	basePath,
	images: { unoptimized: true }, // required: no optimiser in an export
	env: { NEXT_PUBLIC_BASE_PATH: basePath } // exposes it to client and server components
};

export default withMDX(config);
```

### 2. One helper

Keep the prefix in a single place — `src/lib/shared.ts` or wherever your shared utilities
live:

```ts
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function withBasePath(path: string) {
	return `${basePath}${path}`;
}
```

### 3. Where to apply it

Any absolute path to something in `public/` that does **not** go through `next/link`:

- `metadata.icons` in `app/layout.tsx` (the favicon)
- the `src` of any `next/image` written as a literal (`/brand/logo.png`)
- paths read out of JSON or a manifest — wrap them where they are consumed, never bake the
  prefix into the JSON
- any `url()` in CSS pointing at `public/` by absolute path (bundler-imported URLs are fine)

```tsx
import { withBasePath } from '@/lib/shared';

<Image src={withBasePath('/brand/logo.png')} width={64} height={64} alt="" />;
```

```ts
export const metadata: Metadata = {
	icons: { icon: withBasePath('/brand/logo.png') }
};
```

### 4. What needs no change

- `next/link` (`href="/docs"`) — Next prefixes it already.
- Images imported through the bundler (`import logo from './logo.png'`) — the final URL is
  resolved with the base path in it.
- Anything under `_next/static` — served with the prefix automatically.

### 5. Checking the build

```bash
pnpm build
grep -o 'src="[^"]*"' out/index.html | grep -v _next
grep -o '<link rel="icon"[^>]*>' out/index.html
```

Every path to your own assets should carry the prefix (`/s/mi-app/...`), never appear raw
(`/brand/...`), and never point at `/_next/image?url=...` — that last one means
`images.unoptimized` is missing.

### Checklist

- [ ] `basePath` defined once, in `next.config.mjs`
- [ ] `images.unoptimized: true` when `output: 'export'`
- [ ] `NEXT_PUBLIC_BASE_PATH` exposed through `env`
- [ ] a single `withBasePath()`, no repeated literals
- [ ] `metadata.icons` wrapped
- [ ] every `next/image` with a literal path wrapped
- [ ] manifest and JSON paths wrapped where consumed, not in the file
- [ ] build checked with `grep` over `out/`

---

## What PageBox checks for you

The last step above generalises, and PageBox already does it — twice, without being told
which generator produced the build:

- **Before the upload.** The drop area's preflight reads the HTML in the build and warns
  about references that start at the server root instead of this site's base path, naming
  the config line for the generator it detected. It is a blocking warning: you can deploy
  anyway, and the acknowledgement is recorded on the deployment.
- **After it goes live.** `verify.ts` reads the deployed `index.html`, resolves everything it
  references the way the site actually serves it, and records what is missing. The upload
  response carries `brokenAssets` and names the first few in `brokenAssetSamples`.

Two limits worth knowing, because they are exactly where a Next.js favicon slips through:

- the post-deploy check reads **only `index.html`**, and only its first 25 references;
- the preflight samples **at most 10 HTML files** from the build.

So a broken asset on a subpage, or the eleventh page of a docs site, is not caught by
either. The `grep` in step 5 is still worth running on a build you are not sure about.

---

## Adding a generator

`src/lib/preflight.ts` holds the table — the option, its value for a given site, the
snippet, the build command, the output directory, the documentation link, and the
`handled` / `manual` pair this document expands on. Both the preflight warning and the
panel's deploy recipe read it, so they cannot disagree about what to change.

Two things to get right when adding one:

- **The slashes.** Docusaurus, VitePress, Vite and Nuxt require a trailing slash; Next,
  Astro and SvelteKit refuse one; Hugo wants a whole absolute URL. Read it off the official
  documentation rather than assuming — the value in `docs` is where the next person will
  check your work.
- **`test` only if it is certain.** Detection runs on the filenames in an uploaded build.
  Hugo and VitePress produce ordinary directories with no signature, so they have no `test`
  and are never guessed. Naming a config file somebody does not have is worse than saying
  nothing.
