# Accounts, roles and grants

Everything in this document lives on the admin host (`PAGEBOX_ADMIN_HOST`). The site host
only ever offers sign-in, sign-out and the sites themselves.

## First sign-in

The first boot creates a superadmin from `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD`. That password came from a deployment UI and somebody's shell
history, so it is treated as a handover credential: the account is flagged
`must_change_password`, and nothing in the panel opens until it has been replaced.

The same flag is set on every account an admin creates or resets. There is no sign-up
page — accounts only come from somebody who already has one.

Once anyone exists, those variables stop doing anything: a restart must not reopen a closed
account. That also means a forgotten superadmin password has no way back through the
interface, and there is no email delivery yet. The way back is physical access to the
deployment:

```bash
node scripts/set-password.mjs --email you@example.com --password "…"
node scripts/set-password.mjs --email you@example.com --password "…" --keep
node scripts/set-password.mjs --from-env    # put the .env bootstrap credentials back
```

The `.env` fallback needs `--from-env`: run by accident it replaces a password its owner
chose, which is a bad thing for a recovery tool to do quietly.

It revokes every session of that account, and flags the password as one that must be
changed at next sign-in — a password typed on a command line has been in a shell history.
`--keep` skips that when you would rather not be asked again.

## Two sessions, one user table

| Cookie                | Host                  | Lifetime      | What it unlocks             |
| --------------------- | --------------------- | ------------- | --------------------------- |
| `pb_admin.session_token` | `PAGEBOX_ADMIN_HOST` | 30 days       | the panel and the API by cookie |
| `pb_view.session_token`  | `PAGEBOX_SITES_HOST` | 12 hours      | reading private sites       |

Both are host-only — no `Domain` attribute, so neither travels to any other subdomain —
and every session row records which host it was minted for. A session presented on the
other host is treated as no session at all and the mismatch is written to the audit log.

That is the whole reason for two cookies: the panel and the hosted sites are different
origins, and a single cookie valid on both would let any hosted page call the admin API
with the panel session attached.

## Roles

**Global role** — `superadmin`, `admin` or `user`. It says what someone is on the
*instance*; what they can do to any particular site is a grant, below.

| Role         | Count | Is                                                                |
| ------------ | ----- | ----------------------------------------------------------------- |
| `superadmin` | one   | the platform. Every site, every account, every group.             |
| `admin`      | many  | runs their own patch: the sites they create, the accounts they issue, the groups they own. |
| `user`       | many  | no standing on the instance at all; everything comes from a grant. |

### One superadmin

There is exactly one, and Postgres enforces it — a partial unique index over
`role = 'superadmin'`, not a check somebody has to remember. It is created at first boot
and after that it *moves* rather than being granted: **Hand over seat** on the Users page
demotes the holder to `admin` and promotes the target in the same transaction, so there is
never a moment with two of them or none.

That seat is not an editable row. Nobody suspends it, demotes it, resets its password or
deletes it, including itself — the only way out is to hand it over, or `set-password.mjs`
with access to the deployment. An instance whose superadmin has left is recovered by one of
those two, and by nothing else.

### What an admin can and cannot do

An admin **creates sites** (becoming their owner), **issues accounts**, **owns groups**, and
administers all three. It is closed upwards and sideways:

- it cannot create or promote an admin, and cannot demote the account that seated it —
  `set-role` is not in its permission set at all;
- it **only administers the accounts it issued** (`user.created_by_user_id`). Not its peers,
  not their users, not accounts that predate the column. Without that rule any admin could
  reset any password, sign in as that person, and reach whatever sites they reach — so it is
  the single boundary the tier rests on, and every action on the Users page runs through it;
- a group belongs to the admin who created it, for the same reason: membership is a grant
  with an extra step, so a shared group list would be a way into somebody else's sites;
- it can only grant a site to accounts it administers and groups it owns;
- the activity trail it reads is its own — what it and its accounts did, and what was done
  to sites it can act on. The superadmin reads the whole instance.

**`admin` is not a key to other people's sites.** It resolves to no per-site permission
whatsoever: an admin reaches a site by having created it or by being granted it, exactly
like anyone else. Only `superadmin` short-circuits to `owner` everywhere.

**Per-site role**, granted to a person or a group:

| Role       | Can                                                            |
| ---------- | -------------------------------------------------------------- |
| `viewer`   | read the site                                                  |
| `deployer` | read, deploy, activate and roll back                           |
| `owner`    | all of the above, plus grants, deploy tokens and visibility     |

Effective permission on a site is the highest of: superadmin (owner), being the site's
owner (owner), any grant to the person or to a group they belong to, and — for a public
site — `viewer`. `admin` is deliberately absent from that list.

Deleting a site releases its slug on the shared hostname, so it takes both halves: `admin`
or above *and* `owner` on that site. A plain user granted `owner` manages the site and
cannot delete it.

The panel lists sites you can *act* on, so a public site does not appear in your list just
for being public: `deployer` is the floor for opening a site's page. A site you cannot act
on answers 404, never 403, so the panel does not confirm which sites exist.

## Storage quotas

An admin may occupy so many bytes of the bucket, counted across **every deployment their
sites still hold** — not just the live one, because a build kept for rollback takes exactly
as much disk as the one being served. Storage is charged to the site's `owner_user_id`, so
a deployer pushing to somebody else's site spends that owner's allowance.

`PAGEBOX_STORAGE_BYTES` is what the instance has to give away, and it is a number somebody
writes down: S3 has no capacity API, and MinIO and Garage report disk size only through
their own non-S3 admin interfaces. Unset, per-admin quotas still hold and there is no pool
arithmetic.

The pool is hard — quotas may not sum past the total — and the superadmin has no quota of
its own. Its allowance is the remainder, so every quota it hands out visibly shrinks its
own room. An allocation is refused twice over: when the pool has not got it, and when it
would leave the seat less than it is already using.

| Situation | What happens |
| --------- | ------------ |
| Upload larger than what is left | `413`, with `reason: "quota"` and the figures. Nothing is written — the archive's own directory is measured first |
| Retention would free space on this deploy | Counted **before** the fact, so a site keeping its last *N* builds stays deployable at its ceiling |
| Quota lowered below current usage | Allowed. Sites keep serving, nothing is deleted; the next upload is refused until they are under it |
| Admin demoted while owning sites | Refused. Only admins hold quota, so transfer the sites first (see below) |
| Site handed to another admin | Its bytes move to the new owner's allocation, refused unless that admin has room |
| Site with no owner | Unmetered, and reported as such — it occupies the bucket against nobody's allocation |

Existing admins are given `PAGEBOX_DEFAULT_QUOTA_BYTES` at the first boot after upgrading,
and the startup log names anyone that figure leaves over their new limit.

## Groups

A group is a name, an owner and a list of members. Grant a site to the group once instead
of to each person, and membership changes take effect immediately — the permission cache is
dropped whenever a grant, a membership or a site's visibility changes.

The owner is the admin who created it, and only they (or the superadmin) list it, change its
membership or grant on it. Members can only be accounts that admin administers.

Deleting a group removes its memberships and every grant made to it, and releases the slug.
It only ever takes access away: members keep their accounts and any grant made to them
personally.

## Sessions

Changing a password ends every other session on the account. **Sign out everywhere**, on the
account screen, ends all of them including the one pressing it — for a laptop left somewhere
or a cookie believed copied, where the password was never the problem. A suspended account's
sessions stop working at the next request, because the ban is checked on every session read,
not only at sign-in.

## Reading a private site

Every file of a private site is authorised, not just the HTML. A design that checks only
the page leaves the content readable to anyone who learns an asset URL.

| Caller                          | Answer                                              |
| ------------------------------- | ---------------------------------------------------- |
| granted (directly or by group)  | the file                                             |
| signed in, no grant             | 404 — the same answer as a site that does not exist  |
| anonymous, navigating           | 302 to `/login?next=…` on the site host              |
| anonymous, sub-resource         | 401, with no `Location`                              |

The last two are different on purpose. A 302 answering a `<script src>` or a `fetch()`
arrives as HTML where code was expected, so a session expiring mid-visit would break the
page in silence instead of prompting a sign-in.

One consequence worth stating plainly: an anonymous caller can tell a private site *exists*
by getting a login redirect instead of a 404. Hiding that would mean sending readers a 404
instead of the sign-in page, which makes private sites unusable. Signed-in users without a
grant still learn nothing.

Every 404 on the site host is the same document, whatever the reason: an unknown slug, a
site an operator suspended, a site whose deployment was deleted or was never activated, a
private site with no grant, and a path that is simply not in the deployment all answer byte
for byte alike. That is what keeps this table from leaking — a page that read differently
for "suspended" would confirm the site exists. The page says as much, so a visitor whose
link stopped working knows the answer is deliberate rather than knowing why. A deployment
that ships its own `404.html` is the one exception, and only within its own site.

Every response for a private site — including its 404s, 401s and redirects — carries
`Cache-Control: private, no-store`, `CDN-Cache-Control: no-store` and `Vary: Cookie`. One
private asset cached at a CDN edge is readable without a session, which is the worst
failure this design has.

## Throttling

better-auth's own rate limiter does the work, with counters in Postgres (`rate_limit`) so
a restart does not hand an attacker a fresh budget and replicas share one window.

| What | Default | Setting |
| --- | --- | --- |
| sign-in and password change | 10 requests / 5 min per IP | `LOGIN_MAX_ATTEMPTS`, `LOGIN_WINDOW_SECONDS` |
| every other auth endpoint | 120 / min per IP | — |
| a deploy token | 120 calls / hour per key | `API_KEY_MAX_REQUESTS`, `API_KEY_WINDOW_SECONDS` |

The limiter lives in better-auth's handler pipeline, not in its endpoint functions, so
PageBox sends credential calls *through the handler* in-process
(`src/lib/server/auth/credentials.ts`) instead of calling `auth.api.signInEmail`. Calling
the endpoint directly, which is the obvious way to write it, silently skips throttling —
a loop against the login form was answered unlimited until this was fixed.

It counts **requests, not failures** — a successful sign-in spends budget too. That is
better-auth's behaviour, and it matters for anything that signs in repeatedly from one
address, test suites included.

Deploy tokens are throttled by the api-key plugin itself, on every verification, and the
limit is stored on the key. A token over its limit gets `429`, never `401`: a CI job
should retry, not rotate its credentials.

**The proxy must send `X-Forwarded-For`.** The limiter refuses to trust a socket address
behind a proxy, so without that header every caller shares one bucket and a single
attacker can lock everyone out of sign-in. Traefik and Cloudflare set it; a bare
`docker run -p` does not.

## Deploy tokens

Deploy tokens are [better-auth api keys](https://better-auth.com/docs/plugins/api-key):
the plugin owns generation, hashing, expiry, enable/disable and per-key throttling. PageBox
adds one thing — which site a key may deploy to, stored in the key's metadata.

Issue one from the site's page in the panel. The plaintext is shown once and only a hash is
kept, so a lost token is reissued, never recovered. The table shows the first characters of
each key, when it was last used and how many calls it has made; revoking deletes the key.

Tokens bypass the cookie session entirely, which is why the API is exempt from the CSRF
check: a bearer call cannot be made by a browser carrying somebody else's session.

## What the audit log records

Sign-ins and failures, session scope mismatches, password changes, user creation, role
changes, suspensions and resets, site creation and settings, grants added and removed,
tokens issued and revoked, and every deployment created, reused, activated, deleted or
rejected — with the reason. It is readable by anyone signed in to the panel: it is the
record of what happened to shared infrastructure.

## Cross-site request forgery

Cookie-authenticated mutations must carry an `Origin` header whose hostname is the host
being addressed. Scheme and port are deliberately not compared — behind a tunnel the
browser sees `https://pagebox.example.com` while the app sees `http://…:3000` — but the
hostname is what decides which origin a cookie came from.

SvelteKit's built-in check is off, because it compares against a URL rebuilt from proxy
headers: a proxy that forwards the host but not `x-forwarded-proto` turns every panel form
into a 403, and its `trustedOrigins` list cannot hold runtime configuration.
