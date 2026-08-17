# Changelog

All notable changes to PageBox. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.1.0

First release, tracked milestone by milestone (see `docs/IMPLEMENTATION-PLAN.md` §6).

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
