#!/bin/sh
set -eu

# adapter-node caps request bodies at 512 KB by default, which would reject every
# deployment upload long before the app sees it. Keep it tied to the app's own cap so the
# two can never disagree; MAX_UPLOAD_BYTES itself is configurable per deployment (the
# 100 MB default exists because Cloudflare's proxy rejects larger bodies on non-Enterprise
# plans — a deployment that is not behind Cloudflare can raise both freely).
: "${MAX_UPLOAD_BYTES:=104857600}"
export MAX_UPLOAD_BYTES
export BODY_SIZE_LIMIT="${BODY_SIZE_LIMIT:-$MAX_UPLOAD_BYTES}"

# PageBox serves two hostnames from one process, so the request URL must come from the
# proxy headers. Setting ORIGIN instead would collapse both hosts into one and silently
# disable the host split.
export HOST_HEADER="${HOST_HEADER:-x-forwarded-host}"
export PROTOCOL_HEADER="${PROTOCOL_HEADER:-x-forwarded-proto}"
export ADDRESS_HEADER="${ADDRESS_HEADER:-x-forwarded-for}"
export XFF_DEPTH="${XFF_DEPTH:-1}"

# Migrations, bucket creation and the bootstrap superadmin run inside the app process
# (src/lib/server/startup.ts): neither Dokploy nor docker compose has a release phase.
exec node build/index.js
