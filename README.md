# PageBox

Self-hosted static site hosting with real access control: one superadmin runs the
instance and seats admins, each admin runs their own sites, accounts and groups; sites are
`public` or `private`, and for private ones **every asset** (`.js`, `.css`, `.png`) goes
through the authorisation check, not just the HTML.

PageBox never builds anything — it receives already-built artifacts (a `dist/`, a zip, a
lone `index.html`) over an API token or by drag & drop, stores them immutably in S3, and
serves them. Rollback is switching a pointer.

- Deploy API and CI setup: [`docs/deploy-api.md`](docs/deploy-api.md)
- Accounts, roles and grants: [`docs/access.md`](docs/access.md)
- Design brief: [`docs/PLAN-static-hosting.md`](docs/PLAN-static-hosting.md)
- Implementation plan and milestones: [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md)

## Status

**M0–M4 complete** — deployable skeleton (two-host dispatch, schema + migrations, health
check, Docker image, compose stack, Dokploy guide), serving from S3 with the full
resolution, caching and range semantics, the deploy API (token-authenticated zip uploads,
rollback, audit trail), the admin panel (users, groups, grants, deploy tokens, deployment
history), private sites enforced on every file, and drag & drop uploads with a preflight
that catches the base-path mistakes before they ship. What is left is hardening and the
homelab deployment (M7, M8) — see the milestone table in the implementation plan.

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
cp .env.local.example .env.local      # host-side overrides for the compose services
docker compose up -d postgres minio   # dependencies only
pnpm dev
```

Then open **http://pagebox.localhost:5173** for the panel and
**http://pages.localhost:5173** for the sites. Plain `localhost` answers 404 on purpose:
PageBox routes by hostname, and a request that is neither host is not its business.

`.env` holds container hostnames, which only resolve inside the compose network; `.env.local`
points the same variables at the published ports and is loaded after it. Both are read by
the `dev` and `db:*` scripts through Node's `--env-file-if-exists` — Vite does not put
`.env` into `process.env`, so without this the app starts and then refuses to serve.

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

To exercise the deploy API and the panel, run the suite with an account: it issues its own
deploy token through the panel, the same way a person would.

```bash
node scripts/seed-demo.mjs     # also creates e2e-admin@example.com for the suite
PAGEBOX_E2E_BASE=http://127.0.0.1:3000   PAGEBOX_E2E_EMAIL=e2e-admin@example.com PAGEBOX_E2E_PASSWORD=e2e-admin-password pnpm test
```

Point it at your own account if you prefer, but the seeded one exists so the suite never
resets a password somebody is using.

`scripts/verify-real-build.mjs` takes a token directly:

```bash
PAGEBOX_E2E_BASE=http://127.0.0.1:3000 PAGEBOX_E2E_TOKEN=pbx_... node scripts/verify-real-build.mjs
```

## Startup behaviour

The container does everything it needs on boot, because neither Dokploy nor
`docker compose` has a release phase:

1. applies pending migrations, under a Postgres advisory lock;
2. creates the S3 bucket if it is missing (MinIO and Garage alike);
3. creates the first superadmin when the instance has no users, flagged
   `must_change_password`. There is exactly one superadmin seat, enforced by a partial
   unique index; it is handed over from the Users page rather than granted again.

Any failure exits the process rather than serving half-configured traffic. Both migration
and bucket steps can be turned off (`PAGEBOX_MIGRATE_ON_START`,
`PAGEBOX_ENSURE_BUCKET_ON_START`).

## Taking a site down, and keeping its history bounded

A site with a deployment serves it — until somebody says otherwise. **Disable serving** on
the site page takes it off the air without deleting anything: every request answers 404,
for everyone, and the deployments, grants and tokens stay where they are. Enabling it
serves the same build again.

**Delete site** is the other end of that: it removes the site with every deployment,
object, grant and deploy token it has, and releases the slug. It is superadmin-only and
asks for the slug to be typed back, because nothing undoes it. Reach for disable first.

Every deployment is a *full* copy of the build, which is what makes rollback a pointer
move and what makes a site deployed on each push grow without bound. A site can carry a
**retention limit** — set when it is created or later in its settings — and each upload
then deletes the deployments that fall past it. Two things it never does: prune the live
deployment, and prune before the new build is stored. It is never silent either — the
panel names what the next deploy will delete before you press it, and the API answers with
`pruned` and `prunedBytes`.

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
