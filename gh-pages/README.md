# PageBox docs

The landing page and documentation site, built with [Fumadocs](https://fumadocs.dev) on
Next.js and exported to static files. It is its own pnpm project — it does not share the
application's lockfile, and nothing here installs the app.

```bash
pnpm install --ignore-workspace
pnpm dev            # http://localhost:3000
pnpm build          # → out/
pnpm preview        # build, then serve out/ so you see it as deployed
```

## The base path is configuration

The same build answers on three different prefixes, so it is read from the environment
rather than written down:

| Where | `DOCS_BASE_PATH` | Result |
| ----- | ---------------- | ------ |
| `pnpm dev` | unset | `/` |
| GitHub Pages project site | `/PageBox` | `https://<owner>.github.io/PageBox/` |
| a PageBox site | `/s/<slug>` | `https://pages.example.com/s/<slug>/` |

`next.config.mjs` trims a trailing slash, so the value `/api/v1/whoami` returns can be
passed through unchanged.

`DOCS_SITE_URL` sets `metadataBase`, which is only used to absolutise the Open Graph image.

## Deploying

**GitHub Pages** — `.github/workflows/docs.yml`, on every push to `main` that touches this
directory. It builds with the repository name as the base path, greps the output for
references that would escape it, and fails rather than shipping a site whose assets 404.

**PageBox itself** — `.github/workflows/docs-pagebox.yml`, manual or on release. It runs
`scripts/deploy-to-pagebox.sh`, which asks the instance where the site lives before
building:

```bash
PAGEBOX_ADMIN=https://pagebox.example.com \
PAGEBOX_TOKEN=pbx_… \
PAGEBOX_SLUG=docs \
  pnpm deploy:pagebox
```

## Layout

```
content/docs/          the pages, as MDX. meta.json orders each folder.
src/app/(home)/        the landing page
src/app/docs/          the docs layout and the [[...slug]] page
src/components/home/   landing-only pieces — the ledger, the response matrix
src/components/docs/   pieces MDX uses — Recipe, Prefix, SiteTargetField
src/lib/recipes.ts     the per-generator base path table
src/app/global.css     the palette, lifted from the panel's own tokens
public/media/          panel screenshots, light and dark where both exist
```

## The mark

`src/components/pagebox-mark.tsx` is the product's mark — the globe in an open box — copied
from `src/lib/components/PageboxMark.svelte` in the application. `public/brand/favicon.svg`
and the PNGs beside it are copied from `static/`. Change the mark in the app and copy it
here; the geometry is meant to be identical.

`src/components/ledger-mark.tsx` and `public/brand/*-ledger.*` are an earlier mark drawn for
this site — three bars in a box, the top one live. Unused, kept because it says what the
landing page is about at icon size.

## Two things that have to stay in step with the app

- **`src/lib/recipes.ts`** mirrors `src/lib/preflight.ts` in the application, which feeds
  the preflight warning and the panel's deploy recipe. If the option, value or slashes
  change in one, change the other — a site that 404s every asset is the wrong place for two
  opinions.
- **`src/app/global.css`** mirrors the palette in `src/app.css`. The docs are meant to look
  like the console, and both files name the same oklch values.

## Screenshots

`public/media/` is copied from `docs/media/` in the repository root. Files ending `-dark`
are the dark-theme variant of the shot beside them; `src/components/shot.tsx` holds the
manifest of which shots have one, along with each image's real dimensions.

A shot with no dark twin is rendered with a visible mount in dark mode rather than as a
white rectangle — but a real dark capture is better, so add one when you take it.
