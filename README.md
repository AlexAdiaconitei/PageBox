# PageBox

Self-hosted static site hosting with real access control: a superadmin creates users,
groups and sites; sites are `public` or `private`, and for private ones **every asset**
(`.js`, `.css`, `.png`) goes through the authorisation check, not just the HTML.

PageBox never builds anything — it receives already-built artifacts (a `dist/`, a zip, a
lone `index.html`) over an API token or by drag & drop, stores them immutably in S3, and
serves them. Rollback is switching a pointer.

- Deploy API and CI setup: [`docs/deploy-api.md`](docs/deploy-api.md)
- Accounts, roles and grants: [`docs/access.md`](docs/access.md)
- Design brief: [`docs/PLAN-static-hosting.md`](docs/PLAN-static-hosting.md)
- Implementation plan and milestones: [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md)

## Status

**M0–M3 complete** — deployable skeleton (two-host dispatch, schema + migrations, health
check, Docker image, compose stack, Dokploy guide), serving from S3 with the full
resolution, caching and range semantics, the deploy API (token-authenticated zip uploads,
rollback, audit trail), and the admin panel: users, groups, grants, deploy tokens and
deployment history. Private sites are enforced next (M4); see the milestone table in the
implementation plan.

Private sites currently answer 404 for everyone. Sessions, grants and the panel exist now,
but the serving path does not read them until M4 — serving a private site before that
check is in place would be the one unrecoverable mistake here.

First sign-in: the panel is at `PAGEBOX_ADMIN_HOST`, with the bootstrap credentials from
`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`. That password is a handover
credential: nothing else opens until it has been replaced.

## Two hostnames, always

```
https://pagebox.example.com/          → admin panel + API
https://pages.example.com/s/<slug>/   → the deployed sites
```

They must be different hostnames. If `PAGEBOX_ADMIN_HOST == PAGEBOX_SITES_HOST` the
process exits at startup — sharing an origin would let any hosted page call the admin API
with the admin cookie attached.

## Run it

### Standalone (Postgres + MinIO included)

```bash
cp .env.example .env          # set AUTH_SECRET and the bootstrap admin credentials
docker compose up -d          # app + postgres + minio
docker compose --profile cache up -d   # + valkey (needed for >1 replica)
docker compose --profile proxy up -d   # + traefik routing both hostnames on :80
```

Without the proxy profile the app is on `http://localhost:3000` and you address the hosts
with a header:

```bash
curl -H "Host: pagebox.localhost" http://127.0.0.1:3000/healthz
curl -H "Host: pages.localhost"   http://127.0.0.1:3000/
```

With the proxy profile, `*.localhost` resolves to 127.0.0.1 on most systems, so
`http://pagebox.localhost/` works directly.

### Dokploy

See [`docs/dokploy.md`](docs/dokploy.md). Short version: Application → Dockerfile →
two domains → environment variables → health check path `/healthz`.

### Development

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres minio   # dependencies only
pnpm dev                              # http://pagebox.localhost:5173
```

`pnpm check` type-checks, `pnpm test` runs the unit tests, `pnpm db:generate` writes a new
migration after a schema change.

To exercise serving before the upload API exists, publish a generated build by hand and
run the integration suite against it:

```bash
node scripts/seed-demo.mjs                  # seeds /s/demo/ and a private twin
PAGEBOX_E2E_BASE=http://127.0.0.1:3000 pnpm test
```

`scripts/seed-demo.mjs --dir path/to/dist` publishes a real build instead of the generated
one. Both read `.env`, rewriting the compose hostnames to localhost.

To exercise the deploy API instead, issue a token and run the whole suite:

```bash
node scripts/create-deploy-token.mjs --site demo-api --name e2e
PAGEBOX_E2E_BASE=http://127.0.0.1:3000 PAGEBOX_E2E_TOKEN=pbx_... pnpm test
PAGEBOX_E2E_BASE=http://127.0.0.1:3000 PAGEBOX_E2E_TOKEN=pbx_... node scripts/verify-real-build.mjs
```

## Startup behaviour

The container does everything it needs on boot, because neither Dokploy nor
`docker compose` has a release phase:

1. applies pending migrations, under a Postgres advisory lock;
2. creates the S3 bucket if it is missing (MinIO and Garage alike);
3. creates the first superadmin when the instance has no users, flagged
   `must_change_password`.

Any failure exits the process rather than serving half-configured traffic. Both migration
and bucket steps can be turned off (`PAGEBOX_MIGRATE_ON_START`,
`PAGEBOX_ENSURE_BUCKET_ON_START`).

## Upload cap

`MAX_UPLOAD_BYTES` defaults to **100 MB** and is configurable. The default exists because
Cloudflare's proxy rejects larger request bodies on non-Enterprise plans, which is the
first deployment target — a deployment that is not behind Cloudflare (plain Traefik, LAN,
Tailscale, a direct port) can raise it freely. The value also becomes adapter-node's
`BODY_SIZE_LIMIT`, so the app-level cap and the HTTP-level cap can never drift apart.

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones without a default
are required and validated at startup: an invalid configuration stops the process with a
list of what is wrong.
