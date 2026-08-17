# Changelog

All notable changes to PageBox. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.1.0

First release, tracked milestone by milestone (see `docs/IMPLEMENTATION-PLAN.md` §6).

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
