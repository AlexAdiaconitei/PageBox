# Deployment security and upgrades

PageBox 0.3.0 adds authenticator-based 2FA. Its release image tag is `ghcr.io/alexadiaconitei/pagebox:0.3.0`. The earlier security repair evidence is in [security-checks/README.md](security-checks/README.md).

## Upgrade from 0.2 to 0.3

1. Back up PostgreSQL and the bucket, select `PAGEBOX_TAG=0.3.0` and restart PageBox. Check `/healthz` and the migration log.
2. Migration `0010_two_factor.sql` adds the authenticator table, account/session flags and the instance policy. It runs at startup when migrations are enabled. Otherwise run `pnpm db:migrate` before starting the application.
3. The initial 2FA policy is optional. Enable an authenticator under **Account → Manage authenticator**, verify a code and save the recovery codes. Reader accounts can manage their authenticator on the central reader host.
4. To require 2FA for every account, the superadmin first verifies their own authenticator and selects **Required for all users** under **Security**. Existing sessions must verify a second factor or complete enrollment. Test both login hosts and private site access.

No new DNS, proxy or TLS changes are needed for this upgrade. Deploy API keys remain scoped CI credentials. Password resets preserve authenticators; save recovery codes before enabling 2FA. Version 0.2 does not enforce the new policy, so rolling back to it removes mandatory 2FA enforcement. See [the release notes](docs/releases/0.3.0.md).

## Upgrade from 0.1

1. Back up PostgreSQL and the bucket. Stop writes and keep private sites inaccessible while upgrading the proxy and app together.
2. Replace the old environment examples with [.env.example](.env.example). Supply chosen secrets even on localhost. Production startup rejects known placeholders in AUTH_SECRET, bootstrap, database and storage credentials.
3. Configure the panel host and central reader host separately. Uploaded content now uses `<slug-prefix>-<immutable-site-id>.<PAGEBOX_SITES_HOST>`. The prefix holds at most 28 slug characters. Existing `/s/<slug>/` base paths remain unchanged. Old central URLs redirect to the new host.
4. Configure wildcard DNS for `*.pages.example.com`, routing to PageBox and TLS covering that wildcard, the central reader host and the panel host. The supplied Traefik profile is HTTP for local development. Use the actual HTTPS entrypoint and your certificate resolver in production. Copy [the router example](deploy/traefik-dynamic.example.yml), replace its names and backend address, and verify it accepts the generated site URLs.
5. Set PAGEBOX_PUBLIC_SCHEME=https in production. Canonical hosts must include the public port if it differs from the protocol default. For `pnpm dev`, use the hostnames with `:5173` in [.env.local.example](.env.local.example).
6. Select `PAGEBOX_TAG=0.3.0` (or build the checkout with `docker build -t ghcr.io/alexadiaconitei/pagebox:0.3.0 .`). Start the app and check `/healthz` and its migration log. Migrations 0008 and 0009 protect the active deployment reference and create reader authorization/session tables.
7. Re-upload audited source archives for deployments produced before ingest version 3. Stored deployments are not re-extracted by a migration. Keep affected sites disabled until their contents have been reviewed or rebuilt. Old extraction rules could store hidden files or rebase content from a hidden directory.
8. Verify a private site in a browser, then revoke its grant and check its next file request fails. Verify logout and a password reset also revoke access. Test backup restoration before removing the maintenance restriction.

Each site has its own host-only cookie. The central reader login exchanges a 30-second, single-use authorization code for a session bound to that site and its live parent session. HTTPS cookies use the __Host- prefix, Secure, HttpOnly and Path=/, with no Domain. Deleting and recreating a slug creates a different origin, so an old service worker or cookie cannot inherit the new site.

## Storage and credentials

Generate a unique signing key and independent passwords. Use a hex PostgreSQL password in standalone Compose, because its URL embeds the password directly. Percent-encode a password with reserved characters when supplying DATABASE_URL yourself.

Provision the bucket with a separate storage administrator credential. Give PageBox a dedicated key limited by [storage-policy.example.json](storage-policy.example.json), replacing the bucket ARNs if needed. Keep PAGEBOX_ENSURE_BUCKET_ON_START=false. The app key may list that bucket and read, write and delete its `sites/` objects. It must not create buckets or access other buckets or prefixes. MinIO administrator credentials stay out of the app container.

For MinIO, create the user and policy with `mc admin user add`, `mc admin policy create` and `mc admin policy attach`. For Garage, grant read/write access to the selected bucket. Do not attach broader policies to the same key. Object versioning requires an operator-managed lifecycle, because application deletion removes current objects rather than retained historical versions.

After bootstrap, remove BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD from the environment. The database retains the account.

## Network and proxy

Compose binds PageBox, PostgreSQL and both MinIO ports to 127.0.0.1. Only the optional Traefik entrypoint is public. Keep direct app access behind the trusted proxy and do not expose database or storage ports through a tunnel.

The entrypoint uses the actual Host header and socket address by default. Enable HOST_HEADER, PROTOCOL_HEADER and ADDRESS_HEADER only behind a proxy that replaces untrusted incoming headers. Set XFF_DEPTH for the actual topology and configure Traefik trustedIPs if another proxy precedes it. A fixed ORIGIN is incompatible with host routing.

## Upload limits

MAX_CONCURRENT_UPLOADS defaults to 4. MAX_UPLOAD_TEMP_BYTES defaults to 400MB and MAX_UPLOAD_BYTES to 100MB. PostgreSQL advisory locks admit at most the smaller of the concurrency limit and `floor(temp budget / archive cap)` across processes and replicas. Busy admission returns 503. Control connections are separate from the application pool.

UPLOAD_BODY_TIMEOUT_SECONDS defaults to 60; UPLOAD_TIMEOUT_SECONDS defaults to 600. A timed-out body returns 408, its archive is removed and its slot is released. Extraction and S3 writes observe the operation signal. S3 connection and request deadlines are also bounded. Slots remove interrupted archives before reuse and check available disk space. Use an application-owned PAGEBOX_TMP_DIR with enough physical capacity. Before lowering limits, stop all replicas and clear their interrupted archives. All replicas must use the same limit values and database.

## Recovery and fixtures

`scripts/set-password.mjs` changes the password and forced-change flag, revokes sessions and API keys, and records the reset in one transaction. `--keep` skips the forced change while still revoking credentials. A failed audit insertion rolls the reset back.

`scripts/seed-demo.mjs` takes the superadmin seat. It requires `--disposable` or PAGEBOX_DB_TESTS=1 and explicit test credentials. Use it only with disposable data.

## Verification limits

The local checks cover PostgreSQL, MinIO, HTTP, Chromium, the built Docker image and the supplied storage policy. Public DNS, your certificate resolver and your homelab topology have not been changed or tested. Validate them during your deployment using the steps above.

The docs dependency audit retains GHSA-vfj7-8cjw-p6xm in braces 3.0.3, with no patched release available. It is used by the Next ESLint plugin to process repository file patterns. It does not run in the exported documentation or the PageBox image. Avoid feeding untrusted patterns to this tool and update it when a fix is released. The application audit has no advisories.
