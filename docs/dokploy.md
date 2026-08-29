# Deploying PageBox on Dokploy

The image is published, so the shortest route pulls it rather than building on your server:

```
ghcr.io/alexadiaconitei/pagebox:0.1.0
```

| Route                      | Use it when                                                        |
| -------------------------- | ------------------------------------------------------------------ |
| **Application → Docker**   | almost always: pull a released tag, "Add Domain" works              |
| Application → Dockerfile   | you are running a fork, or a commit that has no tag                 |
| Compose                    | you already manage the stack as compose — routing is then yours     |

## Two domains, one container, one port

The part that surprises people. **PageBox is one process listening on one port.** Not two
containers, not two ports, not two paths. Which surface a request reaches is decided by the
`Host` header, before routing:

```
Host: pagebox.example.com   →  the panel and the API
Host: pages.example.com     →  the hosted sites, under /s/<slug>/
Host: anything else         →  404
```

In Dokploy that is **one application with two domains on it**, both at container port 3000.
Traefik matches the hostname and forwards to the same container; PageBox reads the
forwarded host and picks.

Why not two ports, or two paths — neither separates what has to be separated. The sites
host runs JavaScript somebody else uploaded, and the panel's cookie has to be unreachable
from it.

- **Ports do not isolate cookies.** A cookie set on `example.com:3000` is sent to
  `example.com:3001` too: the cookie jar is keyed by host, not by origin. A second port
  would look like a boundary and enforce nothing.
- **Paths are the same origin outright.** With `/panel` and `/sites`, a page you host could
  `fetch('/panel/api/v1/…')` with your admin cookie attached and act as you. It would also
  put every hosted site one directory deeper — the base-path problem, doubled.

Different hostnames are the only split browsers enforce for cookies, so that is the one
PageBox uses, and it refuses to start if the two are equal.

Both are single-level names under a domain you already own, so one wildcard DNS record and
one wildcard certificate cover them. There is no per-site DNS: a new site is a new path on
the sites host.

## Application → Docker (recommended)

1. **Project** → create `app-pagebox` (an application, not a shared resource, so it does not
   belong in a `core`-style project).
2. **Create Application** → *General* → provider **Docker** → image
   `ghcr.io/alexadiaconitei/pagebox:0.1.0`. The package is public, so no registry
   credentials are needed. Pin the version: `latest` moves on the next release.
3. **Domains** → **Add Domain** twice, on this same application:

   | Host                    | Container port | HTTPS               |
   | ----------------------- | -------------- | ------------------- |
   | `pagebox.<your-domain>` | 3000           | on, Let's Encrypt   |
   | `pages.<your-domain>`   | 3000           | on, Let's Encrypt   |

4. **Environment** — the required set:

   ```bash
   PAGEBOX_ADMIN_HOST=pagebox.<your-domain>
   PAGEBOX_SITES_HOST=pages.<your-domain>
   PAGEBOX_PUBLIC_SCHEME=https

   DATABASE_URL=postgres://pagebox:...@<pg-host>:5432/pagebox
   # REDIS_URL=redis://<valkey-host>:6379      # optional; required past 1 replica

   S3_ENDPOINT=http://192.168.1.197:3900       # Garage
   S3_ACCESS_KEY=...
   S3_SECRET_KEY=...
   S3_BUCKET=pagebox
   S3_FORCE_PATH_STYLE=true

   AUTH_SECRET=<openssl rand -base64 48>
   BOOTSTRAP_ADMIN_EMAIL=you@example.com
   BOOTSTRAP_ADMIN_PASSWORD=<first-login password, changed on first use>

   MAX_UPLOAD_BYTES=100MB                      # see note below
   PAGEBOX_STORAGE_BYTES=1GB                   # what this instance has to give away
   PAGEBOX_DEFAULT_QUOTA_BYTES=1GB             # never above the line above
   ```

   Sizes take a unit — `1GB`, `1gb`, `500MB`, `1.5GB`, `2TB` — or a plain number of bytes.
   Units are 1024-based, and `GB` and `GiB` mean the same thing.

   `PAGEBOX_STORAGE_BYTES` is what the panel divides into quotas, and it is a declaration,
   not a measurement: S3 has no capacity API, so write down what the bucket's disk has.
   Leave it out and per-admin quotas still hold; there is just no pool. Note that
   `PAGEBOX_DEFAULT_QUOTA_BYTES` defaults to 5 GB and may not exceed the pool — a 1 GB pool
   without lowering it refuses to start, and says so.

   The two hostnames must match the two domains exactly: they are what the app compares the
   incoming host against. A domain Traefik routes but the app does not know answers 404.

   Provision Postgres with `bash /scripts/provision-pg.sh pagebox` on the database host, and
   a Garage key scoped to the `pagebox` bucket (`PROVISIONING.md §S3`). PageBox creates the
   bucket itself if the key is allowed to; otherwise create it first.

   The proxy headers (`HOST_HEADER`, `PROTOCOL_HEADER`) and `BODY_SIZE_LIMIT` are set by the
   image's entrypoint. Leave them alone, and never set `ORIGIN`.

5. **Health check** → path `/healthz`, port 3000. It probes Postgres and S3, and answers on
   any host (including Dokploy's internal IP probe), so a dependency outage marks the
   container unhealthy instead of silently serving errors.

6. Deploy. The first boot logs migrations, bucket state and the bootstrap superadmin:

   ```
   [pagebox] migrations applied
   [pagebox] bucket "pagebox" created
   [pagebox] bootstrap superadmin created: you@example.com (must change password at first login)
   [pagebox] ready in 336ms · admin=pagebox.<domain> sites=pages.<domain>/s/<slug>/ cache=memory upload-cap=100 MB
   ```

## Application → Dockerfile

Same domains, same environment, same health check; only the source differs — this Git
repository, Build Type **Dockerfile** (`./Dockerfile`), no build args. Your server then
builds on every deploy: minutes instead of seconds, and enough RAM to run a Vite build.
Worth it for a fork, not to run a release.

## Compose (only if you must)

`docker-compose.dokploy.yml` runs the app alone against external services, pulling the same
published image. Remember:

- Compose stacks in Dokploy **ignore** "Add Domain" and container labels for routing. Copy
  `deploy/traefik-dynamic.example.yml` into Dokploy's dynamic config directory (usually
  `/etc/dokploy/traefik/dynamic/pagebox.yml`), adjust hostnames and the container name. Both
  routers point at one service — the same split, written by hand.
- The service must be attached to the `dokploy-network`.

## Upgrading

Deployments are immutable in S3 and the schema migrates forward on boot, so an upgrade is a
new tag and a redeploy: change the image tag, press Deploy, look for `migrations applied`.
Back the database up first when skipping a version. Nothing in the object store is rewritten
by a migration.

Rolling the application back is the previous tag. Rolling a site back is unrelated and never
needs a redeploy — it is a pointer move in the panel.

## Things that bite

- **Both hostnames must differ.** If they match, the container exits at boot with an
  explicit message. That is intentional: a shared origin lets any hosted page call the
  admin API with your admin cookie.
- **A domain Traefik routes but the app does not know answers 404.** Traefik and PageBox
  each keep their own list; adding one without the other gets you a certificate, a working
  route, and a 404 on everything behind it.
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
