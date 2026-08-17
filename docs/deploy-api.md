# Deploy API (v1)

Lives on the admin host, under `/api/v1`. Authentication is a bearer deploy token; the
site host never exposes any of it.

Issue a token from the site's page in the panel. It is shown once and stored only as a
hash, so a lost token is reissued, never recovered. A token scoped to one site cannot see
or touch another: it gets a 404, the same answer as a slug that does not exist.

Tokens are better-auth api keys, so each one is rate limited on its own: 120 calls an hour
by default (`API_KEY_MAX_REQUESTS`, `API_KEY_WINDOW_SECONDS`). Over the limit the API
answers `429` — retry, do not rotate the token.

## Ask for your base path, then build

```http
GET /api/v1/whoami
Authorization: Bearer pbx_…

200 {
  "scope": "site",
  "siteId": "01J…",
  "slug": "docs-a",
  "basePath": "/s/docs-a/",
  "siteUrl": "https://pages.example.com/s/docs-a/",
  "mode": "path",
  "maxUploadBytes": 104857600
}
```

Build with that `basePath` instead of hardcoding it. When a site later moves to its own
hostname (v2), the same call returns `"basePath": "/"` and the next build comes out right
without touching the workflow.

Per generator: Next/Fumadocs `basePath` **and** `assetPrefix`, Docusaurus `baseUrl`,
Astro/Vite `base`, SvelteKit `paths.base`, MkDocs `site_url`.

## Upload a build

The body is the zip itself — no multipart wrapper.

```http
POST /api/v1/sites/docs-a/deployments
Authorization: Bearer pbx_…
Content-Type: application/zip
X-Deployment-Notes: commit abc1234

201 {
  "deploymentId": "01J…",
  "status": "ready",
  "fileCount": 812,
  "totalBytes": 4711234,
  "reused": false,
  "skipped": [],
  "activated": true,
  "url": "https://pages.example.com/s/docs-a/"
}
```

- `?activate=false` uploads without moving the live pointer.
- Re-uploading a byte-identical archive returns the existing deployment with
  `"reused": true` instead of storing a second copy — that is what a retrying CI job does.
- The live pointer moves only after every object is in S3. A failed upload leaves the
  previous deployment serving.

Rejections come back as `400` with a `reason`, or `413` when the body is over
`MAX_UPLOAD_BYTES`:

| `reason`         | Meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| `zip-slip`       | an entry escapes the deployment root (`../`, absolute, `C:/`)   |
| `symlink`        | an entry is a symlink                                           |
| `too-many-files` | over `MAX_FILES`                                                |
| `too-large`      | expands past `MAX_UNCOMPRESSED_BYTES`                           |
| `ratio`          | compression ratio over `MAX_ZIP_RATIO`:1 — treated as a bomb    |
| `empty`          | the archive holds no files                                      |
| `unreadable`     | not a zip, or corrupt                                           |

`401` means the token is unknown, disabled or expired. `429` means this token has made too
many calls in its window.

## Uploading from the panel instead

The same endpoint takes a panel session, which is what the site page's drop area uses. It
differs in three ways:

- no `Authorization` header; the browser session identifies the caller, who needs
  `deployer` on the site;
- it must carry an `Origin` from the admin host, or it is refused with `403` — a
  cookie-authenticated upload is the one a browser can be tricked into making;
- `?warnings=<codes>&acknowledged=1` records what the preflight reported and that someone
  accepted it. Warnings without an acknowledgement are refused with `400`.

The response adds `brokenAssets`: after activation PageBox reads the deployed `index.html`
back and checks the files it references, so a build with a wrong base path reports the
count instead of looking fine.

## The rest

```http
GET    /api/v1/sites/{slug}/deployments?limit=20     # history, newest first
GET    /api/v1/sites/{slug}/deployments/{id}
POST   /api/v1/sites/{slug}/deployments/{id}/activate   # rollback and roll-forward
DELETE /api/v1/sites/{slug}/deployments/{id}            # 409 on the live one
```

## GitHub Actions

```yaml
- id: pb
  run: |
    curl -sfS https://pagebox.example.com/api/v1/whoami \
      -H "Authorization: Bearer ${{ secrets.PAGEBOX_TOKEN }}" \
      | jq -r '"base=" + .basePath' >> $GITHUB_OUTPUT

- run: npm run build
  env:
    # Docusaurus: baseUrl · Next: basePath+assetPrefix · Vite/Astro: base · SvelteKit: paths.base
    SITE_BASE_PATH: ${{ steps.pb.outputs.base }}

- run: (cd dist && zip -qr ../site.zip .)

- run: |
    curl -sfS -X POST https://pagebox.example.com/api/v1/sites/docs-a/deployments \
      -H "Authorization: Bearer ${{ secrets.PAGEBOX_TOKEN }}" \
      -H "Content-Type: application/zip" \
      -H "X-Deployment-Notes: ${{ github.sha }}" \
      --data-binary @site.zip
```

If Cloudflare Access sits in front of the admin host, this workflow stops working unless
you add a bypass policy for `/api/v1/*` or send service tokens
(`CF-Access-Client-Id` / `CF-Access-Client-Secret`).

## Checking a real build end to end

```bash
PAGEBOX_E2E_BASE=http://127.0.0.1:3000 PAGEBOX_E2E_TOKEN=pbx_… \
  node scripts/verify-real-build.mjs
```

Builds `tests/fixtures/real-site` with Vite against the base path `/whoami` returns,
deploys it, and fails if any reference in the served HTML does not resolve.
