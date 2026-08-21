# Example sites

Five deployments, each a different shape, for exercising PageBox against something that
looks like a real site instead of a placeholder. Deploy any of them by dropping the folder
on a site's page, or by zipping it and pushing it with a deploy token.

Every one uses **relative URLs throughout**. These are served from `/s/<slug>/`, so a
leading slash would point at the root of the host instead — which is the single most common
way a build that works locally 404s once it is deployed. The fixtures are the shape you want
to copy.

| Folder | Deployment shape | What it exercises |
| ------ | ---------------- | ----------------- |
| `01-self-contained/` | one `index.html`, nothing else | a single-object deployment; inline CSS, JS and SVG |
| `02-split-assets/` | `index.html` + `assets/` | content-hashed assets served `immutable`, unhashed served `no-cache`, in one deployment |
| `03-assets-downloads/` | images and files | PNG, PDF, ZIP and an extensionless blob — the MIME table, byte ranges, and downloads |
| `04-multipage/` | nested directories | extensionless paths, `guide/index.html`, and a real `404.html` answering **404** |
| `05-spa/` | one document, client routing | SPA fallback answering **200** for paths with no file, without swallowing assets |

## Trying them

```bash
# whole set, one site each
for dir in examples/*/; do
  slug="ex-$(basename "$dir" | cut -d- -f2-)"
  (cd "$dir" && zip -qr /tmp/$slug.zip .)
  curl -sfS -X POST "$ADMIN/api/v1/sites/$slug/deployments" \
    -H "Authorization: Bearer $PAGEBOX_TOKEN" \
    -H "Content-Type: application/zip" \
    --data-binary @/tmp/$slug.zip
done
```

`05-spa` needs **SPA fallback** switched on in the site's settings; without it, `./queue`
and `./archive` answer 404 rather than the shell. `04-multipage` needs it **off**, or its
`404.html` never gets a chance to answer.

## Regenerating the binary assets

`03-assets-downloads` ships real files rather than placeholders — a valid PNG, a valid
one-page PDF, a real zip and a 96 KB blob. They are committed so the bytes never move
between runs, and the script that produced them is beside them so nobody has to trust a
binary in a repo:

```bash
node examples/03-assets-downloads/make-assets.mjs
```

## What is fictional

All of it. The weather station, the print shop, the clock kit, the CLI and the reading queue
do not exist, and the numbers are plausible rather than measured. They are written as real
sites because a fixture full of "Lorem ipsum" tells you nothing about whether your host
serves a real one.
