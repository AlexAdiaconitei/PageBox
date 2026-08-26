# Changelog

All notable changes to PageBox. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.1.0

First release, tracked milestone by milestone (see `docs/IMPLEMENTATION-PLAN.md` §6).

### Added — a README that shows the thing

- **`docs/media/`** — the panel, a served site, the 404 page and a phone screen, captured
  against a throwaway instance seeded from `examples/`, at 2x, in both themes. The README
  leads with them: the panel is most of what PageBox is, and a paragraph describing a
  deployment history is worse than one picture of it. The theme-aware ones are served
  through `<picture>`, so the page follows the reader rather than pinning them to light.
- The README is reorganised around what the thing does — deploy, serve, private sites, the
  record, the error pages, the phone — with the operational sections (running it, startup,
  taking a site down, retention, quotas, the upload cap) kept intact below. Nothing in it is
  new behaviour; it is the same instance, finally visible without cloning the repository.

### Added — one error page, for everything that answers outside the router

- **`$lib/server/errorPage.ts`** — the 404s, 401s, 403s and 405s that never reach SvelteKit
  now render a real page instead of a line of text. Most of them come from the host dispatch
  in `hooks.server.ts` and from `sites/serve.ts`, which run before or instead of route
  resolution, so `src/routes/+error.svelte` was never involved: every one of them was
  `new Response('Not found', …)`, which a browser draws as one serif line on a white page
  with no indication of whose server said it. The document is self-contained — no
  stylesheet, no script, no image, no font file — because an error page that depends on
  assets breaks exactly when assets are what broke, and on the sites host those requests
  would go to an origin whose job is serving somebody else's files. Same palette, same
  dark theme and same type as the panel, so the two error paths are indistinguishable.
- **The shape follows what the caller asked for.** A navigation gets the page; a
  sub-resource gets plain text, because a `<script src>` answered with HTML is a document
  where code was expected and the nosniff header then fails it with a message about the
  wrong thing; an `Accept: application/json` client gets JSON. The status — the part every
  client actually reads — is the same in all three.
- **The 404 stays one answer.** Unknown slug, site taken out of live, site whose deployment
  was deleted or never activated, private site the caller has no grant for, file missing
  inside a deployment: one page, byte for byte, asserted as such in the tests. It is also
  the first version of that page to *say* so — a visitor is told that a site removed from
  live and one that never existed answer alike, which is the honest response to "was this
  ever here?" without answering it. A deployment shipping its own `404.html` still wins:
  a site's not-found page is part of the site.
- **Nothing from the request is reflected.** The requested path never appears. The sites
  host is one origin shared by every deployment, so a document echoing a crafted URL is an
  XSS against every other site on it — not a bet worth taking on an escaping function, for
  a string already visible in the address bar.
- **The panel keeps its console when something fails.** `(panel)/+error.svelte` renders the
  error inside the rail rather than dropping a signed-in operator onto a bare page that
  reads like an ended session, and it names the thing the panel does deliberately: a page
  you may not open answers 404, exactly like one that does not exist, so the message says
  it may be a dead link or a boundary and does not claim to know which.
- A request arriving on neither hostname gets the same page **unbranded** — no mark, no
  name, no mention of where sites live. Which software answers on an address that is not
  ours is not the caller's business.

### Added — example sites, and a deploy recipe per generator

- **`examples/`** — five deployments, each a different shape, for exercising the host against
  something that looks like a real site: one self-contained file; hashed and unhashed assets
  side by side; images, a PDF, a zip and an extensionless blob; nested directories with a
  custom `404.html`; and a client-routed app for the SPA fallback. Every one uses relative
  URLs throughout, which is what `/s/<slug>/` requires and the most common reason a build
  that works locally 404s once deployed. The binary assets are real files with a committed
  script that produces them, so nobody has to trust a blob in the repo.
- **Tabs on the deploy recipe.** Step one used to be a single line naming four tools at once.
  It is now a panel per generator — Next.js (with Fumadocs and Nextra), Docusaurus, Astro,
  VitePress, SvelteKit, Vite, Nuxt and Hugo — carrying the file to edit, the option, this
  site's own value already substituted, the build command, the directory to zip, and a link
  to the official documentation for that option.

  The slash conventions are the point and they are not guessable: Docusaurus, VitePress, Vite
  and Nuxt require a trailing slash, Next, Astro and SvelteKit refuse one, and Hugo wants a
  whole absolute URL. Each was read off the official docs rather than remembered.

  `$lib/preflight` owns the table and both consumers read it, so the warning in the drop area
  and the instructions on the page can no longer name different options for the same tool.
  The tabs are radio inputs, so they switch with no JavaScript and the arrow keys work
  because that is what a radio group already does.

### Fixed — a codebase sweep: races, dead ends and tests that never ran

- **The storage pool was not hard under concurrency.** Every quota decision is check-then-act
  over a live `SUM`, so two deploys by the same admin — or two quotas handed out at once —
  each read a figure the other was about to invalidate, and both passed. Both paths now run
  under a Postgres advisory lock, per owner for spending and one for the pool, taken on a
  reserved connection the way `db/migrate.ts` does.
- **The API's `DELETE /deployments/{id}` dropped its objects before its row, unguarded** —
  the bug already fixed in the panel's action, left in the other half. A storage failure
  there listed a deployment that served nothing and offered to roll back to it.
- **Retention could double-count what it reclaimed.** Two deploys computing the same plan
  both reported the same freed bytes; the delete now counts the rows it actually removed.
- **CI never ran the integration suite.** `pnpm test` skips all of it without
  `PAGEBOX_E2E_BASE`, so "tests passed" meant the unit tests passed. There is now a job with
  Postgres and MinIO that builds, boots, seeds and runs it.
- **Three features had no regression tests.** Disabling, retention and deletion; the admin
  tier; storage quotas — 21 new integration tests across `lifecycle`, `roles` and `quota`,
  plus a shared harness the older suites had each copied.
- **Four security-checklist lines were still only prose**: `Service-Worker-Allowed` never
  emitted, host-only cookies on both hosts, sign-in throttling on both hosts, and a
  hand-built archive carrying a symlink.

### Changed — smaller corrections found in the same sweep

- `site.archived_at` is dropped. Nothing ever wrote it and four code paths guarded against a
  state that could not occur; disabling covers taking a site off the air and deleting covers
  retiring it.
- `apikey.site_id` mirrors the site id the plugin keeps in its free-text `metadata`, so "the
  keys for this site" is an indexed lookup instead of reading every key on the instance and
  parsing JSON in JS on each site page load.
- `sitesForUser` asks the database which sites a caller can reach instead of reading the
  whole table and discarding most of it — it runs on every panel request, through
  `hasOperatorAccess`.
- The activity trail scopes deployments with a subquery rather than materialising every
  deployment id an admin owns into an `IN (…)`.
- `invalidateSite` deletes the slug key exactly instead of dropping a prefix: slugs are not
  prefix-delimited, so invalidating `demo` also dropped `demo-api` and `demo-private`.
- **Sign out everywhere**, on the account screen: ends every session including the caller's,
  for a laptop left behind or a cookie believed copied. Both actions on that page are named
  now, since SvelteKit refuses to mix a default action with named ones.
- **Groups can be deleted**, taking their memberships and the grants made to them. A group
  made by mistake used to hold its slug forever.
- Unowned sites are named and linked on the Users page rather than only weighed.
- A site owner who administers no accounts is told why the grant picker is empty, instead of
  being shown a control that cannot submit.
- The panel says that a dropped `.zip` is sent as is, so its base-path and quota checks
  happen on the server rather than before the upload.
- SIGTERM and SIGINT close the Postgres pool and the Valkey client.
- One `formatBytes`, not three. Dead code removed: `newDeployToken`/`hashToken` (better-auth
  owns key generation), `cacheKeys.siteById` (written, never read), and the `PAGEBOX_BASE_DOMAIN`
  / `PAGEBOX_SUBDOMAIN_MODE` v2 variables, which nothing read.
- `XFF_DEPTH` is documented: it decides which hop of `X-Forwarded-For` is the client, and
  that address is what rate limiting and the audit trail key on.

### Added — storage quotas, allocated out of one declared pool

Nothing stopped an admin filling the bucket. Now each one may hold so many bytes across
every deployment their sites keep — history included, because a build kept for rollback
occupies exactly as much disk as the one being served — and storage is charged to the
site's owner, so a deployer pushing to somebody else's site spends that owner's allowance.

- **`PAGEBOX_STORAGE_BYTES`, optional.** What the instance has to give away, and a
  *declaration* rather than a measurement: S3 exposes no capacity figure, and MinIO and
  Garage report disk size only through their own non-S3 admin APIs. Set it and the pool is
  real; unset, per-admin quotas still hold with no pool arithmetic to do.
- **A hard pool.** Quotas may not sum past the total. The superadmin has no quota of its
  own — its allowance is the remainder, so every quota it hands out shrinks its own room,
  and an allocation is refused both when the pool has not got it and when it would leave
  the seat less than it is already using.
- **Retention counts before the fact.** The allowance for an upload is
  `quota − (used − what this deploy's retention will drop)`, so a site keeping its last *N*
  builds stays deployable at its ceiling instead of needing builds deleted by hand. The
  bucket briefly holds both, since pruning still runs after the upload lands.
- **Refused before a byte is written.** The archive's own central directory is measured
  through the same skip and rebase rules extraction uses, so the figure is exact rather
  than an over-estimate that refuses a build which would have fitted. A guard inside
  `extractZipToS3` is the backstop for an archive that misreports itself. The API answers
  `413` with `reason: "quota"` and the arithmetic; the panel's drop area refuses before
  packing, and `GET /deployments` reports the allowance.
- **Lowering a quota below current usage is allowed.** It is the tool for reclaiming space
  from an admin who has taken it, and it would be useless if it needed their cooperation.
  Nothing of theirs is deleted: they are over, their sites keep serving, their next upload
  is refused until they are under.
- **Transfer a site to another admin.** Its storage moves with it, refused unless the new
  owner has room. This is also what makes demotion workable — an admin can no longer be
  demoted while they own sites, because only admins hold quota and stranded bytes would
  belong to no allocation.
- Sites with no owner are reported as unmetered on the Users page rather than being
  silently charged to the seat.

Migration 0006 adds `user.storage_quota_bytes`. Existing admins are given
`PAGEBOX_DEFAULT_QUOTA_BYTES` at the first boot after upgrading — done at startup, not in
SQL, because the migration cannot read the environment — and the log names anyone that
figure leaves over their new limit. Set it before upgrading if your admins already hold
more than the 5 GB default.

### Changed — three roles, one superadmin, and a boundary between admins

The instance had two global roles, `superadmin` and `user`, and any number of superadmins.
That made "admin" and "owner of the platform" the same account: the only way to let someone
issue accounts was to hand them every site on the instance. A middle tier now exists, and
the top one is a single seat.

- **`admin`.** Creates sites (becoming their owner), issues accounts, owns groups, and
  administers all three. Closed upwards — `set-role` is not in its permission set, so it
  cannot mint or promote a peer, nor demote whoever seated it. It resolves to **no**
  per-site permission: an admin reaches a site by having created it or by being granted it,
  exactly like anybody else. Only `superadmin` still short-circuits to `owner` everywhere.
- **One superadmin, enforced by Postgres.** A partial unique index over `role = 'superadmin'`
  rather than a guard somebody has to remember. The seat is not an editable row — nobody
  suspends, demotes, resets or deletes it — and it moves by **Hand over seat**, which
  demotes the holder and promotes the target in one transaction, so there is never a moment
  with two or none. Without that, a superadmin who leaves takes the instance with them: the
  bootstrap variables are inert once any account exists.
- **`user.created_by_user_id`.** The single rule the tier rests on: an admin administers the
  accounts it issued and nothing else. Any admin able to reset any password could sign in as
  that person and reach whatever sites they reach, so this is what keeps two admins apart.
  Every action on the Users page runs through one predicate (`manages()`), never through the
  role alone.
- **`group.owner_user_id`.** Membership is a grant with an extra step, so a shared group list
  was the same hole by another route — an admin adding their own people to somebody else's
  group walks into the sites it was granted on. A group now belongs to whoever made it, and
  its members can only be accounts that admin administers.
- **Scoped surfaces.** The grant picker on a site offers only accounts you administer and
  groups you own, re-checked server-side because `principal` is a plain form field. The
  activity trail an admin reads is its own — what it and its accounts did, and what was done
  to sites it can act on — instead of every deploy, token and sign-in on the instance.
- Deleting a site now takes `admin` or above *and* `owner` on that site, rather than
  superadmin: it releases a slug on the shared hostname, so it needs standing plus ownership.

Migration 0005 adds both columns and the index. An instance with several superadmins keeps
the oldest — the account it was bootstrapped with — and steps the rest down to `admin`,
which is the tier that describes what they were already doing. Accounts that predate
`created_by_user_id` stay unattributed and remain the superadmin's to administer.

### Fixed — a deploy token outlived the permission it was issued under

- Token authentication checked the key's hash, expiry, rate limit and site scope, and never
  looked at the person it belongs to. Removing someone's grant, demoting them or suspending
  the account left every token they had cut still deploying, which made those grants
  unrevokable in practice. The owner's current permission is now resolved on every
  token-authenticated call, `/whoami` included — which used to hand a site's slug, base path
  and visibility to any valid key with no permission check at all.
- A key carrying no site scope used to mean "any site its owner can reach". The panel is the
  only thing that issues keys and always sets the scope, so the only key reaching that branch
  came from somewhere else. Default-deny.
- Revoking a deploy token somebody else issued threw: better-auth's `deleteApiKey` scopes
  deletion to the caller's own keys and answers `KEY_NOT_FOUND` for anyone else's, so an
  owner pressing Revoke on a co-owner's token got a 500 and a token that still worked. A
  deploy token belongs to the site it was cut for, and the site's owners revoke it.

### Fixed — the grant picker did not exist without JavaScript

- The searchable picker rendered a text input and built its option list only while open, so
  the server sent a page whose only control could never resolve a principal: granting access
  with JavaScript off was impossible, and the page's HTML did not say what the choices were.
  The server now renders a plain `<select>` over the same options, grouped by kind, and the
  search box replaces it once the component mounts.

### Fixed — a deleted deployment could leave the panel offering a rollback to nothing

- Objects were dropped before the row, and a storage failure was not checked: the deployment
  stayed listed, stayed rollback-able, and served nothing. The row is now removed only once
  its objects are actually gone, and a refusal from storage says so instead of half-deleting.

### Fixed — the suspend button posted the state and let the server invert it

- A page rendered before somebody else changed the row suspended the account it meant to
  restore. `?/suspend` and `?/restore` each do one thing and are idempotent.

### Fixed — smaller things

- `formatBytes` stopped at GB, so a few terabytes of stored builds read as `4096.0 GB`.
- The login page's `safeNext` took a host kind and ignored it. The site host now accepts only
  a path under the sites prefix, instead of leaning on the route whitelist to 404 the rest.
- The example `AUTH_SECRET` and `BOOTSTRAP_ADMIN_PASSWORD` are refused once the instance is
  addressable under a real hostname — the credentials in an example file are the ones people
  ship. Checked on reachability rather than `NODE_ENV`, because the Docker image sets
  production and a laptop running it under `*.localhost` is not a deployment. The values are
  never echoed into the error.
- There was no `+error.svelte`, so the id `handleError` logs beside every stack trace never
  reached the screen — a 500 in a form action was a blank wall. The error page now shows it.

### Added — a site can be switched off, and its history can be bounded

- **Serving switch.** A site used to be published by the sole fact of holding a deployment,
  so the only way to take one down was to delete the build that made it work. `site` now
  carries `disabled_at` and an optional reason; a disabled site answers the same 404 as one
  that never existed, checked before visibility and before any grant lookup so it is off
  for its owner too. Nothing is deleted — enabling it serves the same build again.
- **Delete.** The counterpart to disabling, and the reason disabling exists: a site merely
  in the way should be switched off, one that should never have existed is removed —
  deployments, objects, grants and deploy tokens together, releasing the slug. Superadmin
  only, the slug has to be typed back, and the row goes only once the objects have.
- **Retention limit.** Every deployment is a full copy of the build, which is what makes
  rollback a pointer move and what makes a site deployed on each push grow without bound.
  A site can keep its last *N* deployments (`retention_limit`, set at creation or in
  settings) and each upload drops what falls past it. Never the live one, never before the
  new build is stored, and never silently: the panel names what the next deploy will delete
  before it happens, the upload response carries `pruned` and `prunedBytes`, and the trail
  gets a `deployment.pruned` entry.
- **Size, where the question is asked.** The Sites list shows what each site occupies
  across every deployment it holds, plus fleet totals for stored bytes and disabled sites;
  the site page shows stored bytes, deployment count, the live build's size and the limit
  in force. `GET /deployments` returns `serving`, `retentionLimit`, `storageBytes` and
  `deploymentCount`.

### Changed — the account screen is part of the panel, and passwords can be read back

- Changing a password used to leave the panel for a bare centred form, reachable two ways
  from the same corner — the account name and a key icon beside it — which read as two
  destinations and were one. It is now a panel view with the rail still in place, reached
  by the account name on a desktop and an Account tab on a phone; the key icon is gone.
- Every password field in the app is one component with a reveal toggle. A credential you
  cannot read is one that gets set to something nobody can reproduce, and "repeat it below"
  only catches the same typo twice. The temporary passwords a superadmin issues start
  visible — they are being read out to somebody, not kept.
- A voluntary password change now stays on the account screen and says it worked. Only a
  forced one still redirects into the panel, because clearing the gate is the point of it.

### Fixed — re-uploading an archive resurrected a deployment built by older rules

- Deployments record which extraction rules produced them (`ingest_version`), and an upload
  only reuses one made by the current rules. The same bytes expand differently after a rule
  changes — rebasing onto a single root did exactly that — so a checksum alone cannot decide
  two deployments are the same thing.
- Reuse also checks the stored deployment is still intact before activating it.

### Fixed — an archive wrapping everything in one folder deployed a broken site

- `zip -r site.zip out` puts every path under `out/`, and the API stored it verbatim: the
  site root held one directory and no `index.html`, so the site answered Not Found. The API
  now rebases onto a single top-level directory, the way the panel's drop area already did,
  and reports which one in `root`.
- Directory entries no longer appear in `skipped` — they are not files, and listing them
  read like something had gone wrong.

### Fixed — post-deploy verification called working links broken

- It checked each reference as a literal object key, so a link to another page —
  `href="docs"`, served from `docs.html` or `docs/index.html` — counted as a missing asset.
  It now resolves references with the same rules the site serves them by, and ignores the
  404 page as a match.
- The upload response names the first missing files (`brokenAssetSamples`) instead of only
  counting them, and the server logs them.

### Fixed — the drop preflight called correct Next.js builds broken

- A root-absolute reference is only wrong when it points outside the site. A build made
  with the right base path emits `/s/<slug>/…` everywhere, and the preflight was flagging
  exactly that as "this build points at the server root", with a generator hint telling it
  to set the base path it already had.
- References that carry the site's base path now produce a confirmation instead
  (`Built for /s/<slug>/`), and the generator hint only appears when there is something to
  fix. Mixed builds still block, listing only the references that are actually wrong.

### Fixed — a superadmin got 404 on private sites, and boots could hang before the first log line

- The site host runs its own auth instance, without the admin plugin — so the `role` and
  `banned` fields it declares were missing there, and every superadmin read a private site
  as an ordinary user (404) while a banned user read it as clean. Both fields are now
  declared on that instance too.
- Migrations took their advisory lock from a connection pool: the lock was acquired on one
  connection and released on another, so it stayed held and every later start blocked
  forever on `pg_advisory_lock`, before any log line. It now reserves a single connection,
  waits with `pg_try_advisory_lock`, and fails after a minute with the query to find a
  stale holder. The startup log says it is applying migrations before it starts.
- Links printed by the panel and the API keep the port of the request they answer, so they
  work on a dev server or any deployment not on 80/443.
- `scripts/seed-demo.mjs` creates the integration suite's own superadmin, so tests stop
  using — and resetting — a real person's account.

### Fixed — sign-in refused its own origin outside the container

- better-auth trusted only its `baseURL`, which carries no port, so signing in from the dev
  server on `:5173` failed with `INVALID_ORIGIN`. It now applies PageBox's own rule: the
  hostname must be one of the two configured hosts, and scheme and port are not compared,
  because behind a tunnel neither survives.

### Fixed — the password change form reported a wrong password when the call was wrong

- Credential calls made through better-auth's handler now forward `Origin`. Without it
  better-auth answered `403 MISSING_OR_NULL_ORIGIN`, which the form turned into "the
  current password is wrong" — pointing at the credentials instead of at the bug.
- A refusal is only reported as a bad password when better-auth says so; anything else says
  the server log has the reason, and the reason is logged.
- The deploy API accepts a panel session on every route, not only on upload, so the panel
  can read a single deployment.

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
