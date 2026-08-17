# Changelog

All notable changes to PageBox. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.1.0

First release, tracked milestone by milestone (see `docs/IMPLEMENTATION-PLAN.md` §6).

### Added — password recovery from the host

- `scripts/set-password.mjs` sets an account's password directly against the database, for
  when the superadmin password is lost: `BOOTSTRAP_ADMIN_*` only applies to an empty
  instance, and there is no email delivery. It revokes the account's sessions and, unless
  `--keep` is given, requires a change at next sign-in.

### Added — M6: drag & drop uploads

- Drop a `dist/` folder, a `.zip` or a lone `index.html` onto a site's page. The archive is
  packed in the browser in store mode and sent to the same endpoint CI uses.
- The deployment endpoint accepts a panel session as well as a bearer token, with identical
  guards; the cookie path is covered by the same-origin check.
- Preflight before anything is uploaded: the root is guessed when everything sits inside one
  folder, a missing `index.html` is flagged, root-absolute references are reported with the
  paths that will 404, the generator is named with its exact base-path setting, and
  dotfiles, `.git` and `node_modules` are left out.
- A build that will not work deploys only behind an explicit acknowledgement, and the
  warnings plus the time they were accepted are stored on the deployment.
- After activation, the deployed `index.html` is read back and the files it references are
  checked; the count of missing ones is shown in the deployment list.

### Changed — deploy tokens and throttling now come from better-auth

- Deploy tokens are `@better-auth/api-key` keys: generation, hashing, expiry,
  enable/disable and per-key rate limiting are the plugin's, and PageBox only records which
  site a key may deploy to, in the key's metadata. The `deploy_token` table is gone;
  `apikey` replaces it.
- A token over its own limit gets `429` instead of `401`, so a CI job retries rather than
  rotating credentials.
- Sign-in and password change go through better-auth's HTTP handler in-process, which is
  where its rate limiter lives — calling the endpoint functions directly skipped it. The
  hand-written limiter added in M4 is gone.
- Rate limit counters live in Postgres (`rate_limit`), so a restart does not reset them and
  replicas share one window. The proxy must send `X-Forwarded-For`, or every caller shares
  one bucket.
- `scripts/create-deploy-token.mjs` is removed: tokens are issued from the panel, which is
  also the path the tests now exercise.

### Added — M4: private sites

- Private sites are authorised per file, HTML and assets alike, against the reader's
  `pb_view` session and the site's grants.
- Anonymous navigations are sent to `/login?next=…`; anonymous sub-resources get a dry
  401, never a redirect that would arrive as HTML where code was expected.
- A signed-in reader without a grant gets 404 — the same answer as a site that does not
  exist.
- Public sites keep the fast path: no session lookup, nothing to authorise.
- Credential throttling for sign-in and password change: ten failed attempts per five
  minutes, counted per IP and per account, configurable with `LOGIN_MAX_ATTEMPTS` and
  `LOGIN_WINDOW_SECONDS`. Successful sign-ins never count.

### Added — M3: authentication and admin panel

- Two better-auth instances over the same tables: `pb_admin` on the admin host and
  `pb_view` on the site host. Every session row carries its scope and is refused when
  presented on the other host; the mismatch is audited.
- Sign-in and sign-out on both hosts, sign-up disabled, rate limiting on credentials, and
  a forced password change while an account still holds its handover credential.
- Panel: sites (list, create, settings), deployments (activate, rollback, delete), grants
  to users and groups, deploy tokens issued and revoked from the UI, user administration
  (create, suspend, role, password reset), groups with membership, and the audit trail.
- Effective permissions (`superadmin` / owner / grants / public) with a short-lived cache
  invalidated on every grant, membership and visibility change.
- CSRF: cookie-authenticated mutations must carry an `Origin` whose hostname matches the
  host being addressed. Bearer-authenticated API calls are exempt.
- Panel design system: dense hairline tables, monospace for copyable values, lucide icons,
  light and dark palettes.

### Added — M2: deploy API

- `GET /api/v1/whoami`: CI asks for its own `basePath` before building, so the prefix is
  never hardcoded in a workflow.
- `POST /api/v1/sites/{slug}/deployments`: the request body is the zip. Streamed to a temp
  file, hashed, then walked entry by entry into S3; the live pointer moves only once every
  object is stored. `?activate=false` uploads without switching.
- Re-uploading a byte-identical archive reuses the existing deployment (`reused: true`)
  instead of storing a second copy.
- `GET` history, `GET` one deployment, `POST .../activate` (rollback and roll-forward), and
  `DELETE` — refused with 409 on the live deployment.
- Zip guards, all enforced while reading: zip-slip and absolute paths, symlink entries,
  file-count cap, uncompressed-size cap and compression ratio. Each rejection reports its
  own `reason`.
- Bearer deploy tokens, stored as sha256 with a visible prefix, revocable and expirable;
  a token scoped to another site gets a 404, never a 403.
- Audit entries for every create, reuse, activate, delete and rejection.
- Sweeper for uploads that died mid-flight: at boot and hourly.
- `scripts/create-deploy-token.mjs` and `scripts/verify-real-build.mjs` (builds a real Vite
  site against the API's base path, deploys it, and checks every reference resolves).

### Added — M1: serving deployments

- `serveSite`: resolves a request subpath against the active deployment following the six
  rules in the design brief (exact, `.html`, `/index.html`, directory index, SPA shell,
  site `404.html`), and streams the object from S3.
- Own extension-to-MIME table; S3 object metadata is never trusted for `Content-Type`.
- `ETag` / `If-None-Match` → 304, byte ranges → 206 with `Content-Range`, `HEAD`, and 405
  for any other method.
- Precompressed `.br` / `.gz` siblings served on content negotiation, with a per-deployment
  negative cache so a build without them costs one extra round-trip, not one per asset.
  Ranged requests always get the plain object.
- Cache policy: hashed assets `immutable` for a year, HTML and 404s revalidating, and
  private sites forced to `private, no-store` plus `CDN-Cache-Control: no-store`.
- Guards: dotfiles at any depth, `__pb/*`, and path traversal all answer 404; private sites
  answer 404 for every path until sessions land in M4.
- `scripts/seed-demo.mjs` to publish a generated build without the upload API, and an
  opt-in integration suite (`PAGEBOX_E2E_BASE`) covering all of the above.
- Compose now publishes the Postgres and MinIO ports, as the documented dev flow needs.

### Added — M0: deployable skeleton

- SvelteKit (adapter-node) app serving the admin host and the site host from a single
  deployable, dispatched in `hooks.server.ts` by request host.
- Startup validation: the process exits when `PAGEBOX_ADMIN_HOST` equals
  `PAGEBOX_SITES_HOST`, when `AUTH_SECRET` is too short, when more than one replica is
  configured without a shared cache, or when the upload caps contradict each other.
- Postgres schema and first migration: better-auth tables (`user`, `session`, `account`,
  `verification`) plus `site`, `deployment`, `site_grant`, `group`, `group_member`,
  `deploy_token`, `audit_log`.
- In-process startup tasks: migrations under a Postgres advisory lock, S3 bucket creation,
  bootstrap superadmin flagged `must_change_password`.
- `GET /healthz` probing Postgres and S3, answering host-less container probes with a
  reduced body.
- Grant/site cache with two backends: in-process memory (default) and Valkey (`REDIS_URL`).
- S3 client for Garage and MinIO (path-style), with range-aware reads and prefix deletion.
- Docker image (multi-stage, non-root, healthcheck), standalone `docker-compose.yml`
  (Postgres + MinIO, optional Valkey and Traefik profiles), `docker-compose.dokploy.yml`,
  Traefik dynamic example, and the Dokploy guide in `docs/dokploy.md`.
- Configurable upload cap `MAX_UPLOAD_BYTES` (default 100 MB, Cloudflare's non-Enterprise
  body limit) propagated to adapter-node's `BODY_SIZE_LIMIT`.
- Unit tests for configuration validation and site-path parsing; CI running format, types,
  tests and a Docker image build.

### Notes

- `better-auth` is pinned to 1.6.26: releases 1.6.27–1.6.29 depend on `better-call@1.4.0`,
  which requires an unpublished `@better-auth/utils@^0.5.0`.
