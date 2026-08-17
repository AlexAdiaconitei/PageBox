# Deploying PageBox on Dokploy

Two routes. **Use the Application one** unless you have a reason not to: Dokploy's
Compose stacks are not routed by "Add Domain", so they need a hand-written Traefik dynamic
file (`traefik-dynamic.example.yml`).

## Application (Dockerfile) — recommended

1. **Project** → create `app-pagebox` (it is an app, not a shared resource, so it does not
   belong in a `core`-style project).
2. **Create Application** → source: this Git repository → Build Type: **Dockerfile**
   (`./Dockerfile`), no build args needed.
3. **Domains** → **Add Domain** twice, both pointing at container port **3000**:
   - `pagebox.<your-domain>` — panel and API
   - `pages.<your-domain>` — the hosted sites

   Both are single-level hostnames, so an existing `*.<your-domain>` wildcard certificate
   and tunnel rule already cover them: no per-site DNS, no catch-all router.

4. **Environment** — the required set:

   ```bash
   PAGEBOX_ADMIN_HOST=pagebox.<your-domain>
   PAGEBOX_SITES_HOST=pages.<your-domain>
   PAGEBOX_PUBLIC_SCHEME=https

   DATABASE_URL=postgres://pagebox:...@<pg-host>:5432/pagebox
   # REDIS_URL=redis://<valkey-host>:6379      # optional; required if you scale past 1 replica

   S3_ENDPOINT=http://192.168.1.197:3900       # Garage
   S3_ACCESS_KEY=...
   S3_SECRET_KEY=...
   S3_BUCKET=pagebox
   S3_FORCE_PATH_STYLE=true

   AUTH_SECRET=<openssl rand -base64 48>
   BOOTSTRAP_ADMIN_EMAIL=you@example.com
   BOOTSTRAP_ADMIN_PASSWORD=<first-login password, changed on first use>

   MAX_UPLOAD_BYTES=104857600                  # 100 MB — see note below
   ```

   Provision Postgres with `bash /scripts/provision-pg.sh pagebox` on the database host,
   and a Garage key scoped to the `pagebox` bucket (`PROVISIONING.md §S3`). PageBox creates
   the bucket itself if the key is allowed to; otherwise create it first.

5. **Health check** → path `/healthz`. It probes Postgres and S3, and answers on any host
   (including Dokploy's internal IP probe), so a dependency outage marks the container
   unhealthy instead of silently serving errors.

6. Deploy. The first boot logs migrations, bucket state and the bootstrap superadmin:

   ```
   [pagebox] migrations applied
   [pagebox] bucket "pagebox" created
   [pagebox] bootstrap superadmin created: you@example.com (must change password at first login)
   [pagebox] ready in 336ms · admin=pagebox.<domain> sites=pages.<domain>/s/<slug>/ cache=memory upload-cap=100 MB
   ```

## Compose (only if you must)

`docker-compose.dokploy.yml` runs the app alone against external services. Remember:

- Compose stacks in Dokploy **ignore** "Add Domain" and container labels for routing.
  Copy `traefik-dynamic.example.yml` into Dokploy's dynamic config directory (usually
  `/etc/dokploy/traefik/dynamic/pagebox.yml`), adjust hostnames and the container name.
- The service must be attached to the `dokploy-network`.

## Things that bite

- **Both hostnames must differ.** If they match, the container exits at boot with an
  explicit message. That is intentional: a shared origin lets any hosted page call the
  admin API with your admin cookie.
- **Upload cap and Cloudflare.** `MAX_UPLOAD_BYTES` defaults to 100 MB because Cloudflare's
  proxy rejects bigger request bodies on non-Enterprise plans. Raise it when nothing in
  front imposes a smaller cap; it propagates to adapter-node's `BODY_SIZE_LIMIT`
  automatically. Traefik itself does not cap bodies unless you add a `buffering`
  middleware.
- **CF Access in front of the panel** is tempting, and it breaks CI: the token-based API
  lives on the admin host. Either add a bypass policy for `/api/v1/*` or use service tokens
  (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) in the workflow. Never put CF Access
  in front of the sites host — public sites would stop being public.
- **Scaling past one replica** requires `REDIS_URL`; the app refuses to start otherwise,
  because the grant cache would be per-process.
- **Proxy headers**: the app reads `x-forwarded-host` / `x-forwarded-proto` (set by
  Traefik). Do not set `ORIGIN` — a fixed origin collapses the two hostnames into one and
  disables the host split.
