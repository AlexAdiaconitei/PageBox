# PageBox

Self-hosted static site hosting with real access control: a superadmin creates users,
groups and sites; sites are `public` or `private`, and for private ones **every asset**
(`.js`, `.css`, `.png`) goes through the authorisation check, not just the HTML.

PageBox never builds anything — it receives already-built artifacts (a `dist/`, a zip, a
lone `index.html`) over an API token or by drag & drop, stores them immutably in S3, and
serves them. Rollback is switching a pointer.

- Design brief: [`PLAN-static-hosting.md`](PLAN-static-hosting.md)
- Implementation plan and milestones: [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md)

## Status

**M0 complete** — deployable skeleton: two-host dispatch, schema + migrations, health
check, Docker image, compose stack, Dokploy guide. Serving deployments (M1) and the API
(M2) are next; see the milestone table in the implementation plan.

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

See [`deploy/dokploy.md`](deploy/dokploy.md). Short version: Application → Dockerfile →
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
