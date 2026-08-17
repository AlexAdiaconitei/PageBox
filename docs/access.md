# Accounts, roles and grants

Everything in this document lives on the admin host (`PAGEBOX_ADMIN_HOST`). The site host
only ever offers sign-in, sign-out and the sites themselves.

## First sign-in

The first boot creates a superadmin from `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD`. That password came from a deployment UI and somebody's shell
history, so it is treated as a handover credential: the account is flagged
`must_change_password`, and nothing in the panel opens until it has been replaced.

The same flag is set on every account a superadmin creates or resets. There is no sign-up
page — accounts only come from a superadmin.

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

**Global role** — `superadmin` or `user`. A superadmin can do everything on every site, and
is the only role that can create accounts, change roles, suspend people, reset passwords,
create sites and manage groups.

**Per-site role**, granted to a person or a group:

| Role       | Can                                                            |
| ---------- | -------------------------------------------------------------- |
| `viewer`   | read the site                                                  |
| `deployer` | read, deploy, activate and roll back                           |
| `owner`    | all of the above, plus grants, deploy tokens and visibility     |

Effective permission on a site is the highest of: superadmin (owner), being the site's
owner (owner), any grant to the person or to a group they belong to, and — for a public
site — `viewer`.

The panel lists sites you can *act* on, so a public site does not appear in your list just
for being public: `deployer` is the floor for opening a site's page. A site you cannot act
on answers 404, never 403, so the panel does not confirm which sites exist.

## Groups

A group is a name and a list of members. Grant a site to the group once instead of to each
person, and membership changes take effect immediately — the permission cache is dropped
whenever a grant, a membership or a site's visibility changes.

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

Every response for a private site — including its 404s, 401s and redirects — carries
`Cache-Control: private, no-store`, `CDN-Cache-Control: no-store` and `Vary: Cookie`. One
private asset cached at a CDN edge is readable without a session, which is the worst
failure this design has.

## Throttling

Sign-in and password change count failed attempts per IP and per account: ten per five
minutes by default, `LOGIN_MAX_ATTEMPTS` and `LOGIN_WINDOW_SECONDS` to change it — raise
the count for a team that shares one public address. Successful sign-ins never count
against the limit.

better-auth's own rate limiter is not in play here: it lives in its HTTP handler, and
PageBox calls the auth API directly so the site host does not expose better-auth's routes.

## Deploy tokens

Issued per site from the site's page, or unscoped from the command line
(`scripts/create-deploy-token.mjs`). Only the sha256 is stored; the plaintext is shown once
and cannot be recovered, only reissued. Every token shows its prefix and when it was last
used, and can be revoked at any time.

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
