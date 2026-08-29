#!/bin/sh
set -eu

# adapter-node caps request bodies at 512 KB by default, which would reject every
# deployment upload long before the app sees it. Keep it tied to the app's own cap so the
# two can never disagree; MAX_UPLOAD_BYTES itself is configurable per deployment (the
# 100 MB default exists because Cloudflare's proxy rejects larger bodies on non-Enterprise
# plans — a deployment that is not behind Cloudflare can raise both freely).
#
# The value may carry a unit — `100MB`, `1.5GB` — or be a plain number of bytes, and
# adapter-node reads BODY_SIZE_LIMIT itself, before the app has parsed anything. So the
# grammar has to be understood twice: here, and in src/lib/server/config.ts, which owns it.
# Keep the two in step.
#
# Anything this cannot read is left alone: BODY_SIZE_LIMIT stays unset, the process starts,
# and config validation kills it a moment later with a message that names the variable and
# says what a size looks like. A shell error here would say none of that.
: "${MAX_UPLOAD_BYTES:=104857600}"
export MAX_UPLOAD_BYTES

if [ -z "${BODY_SIZE_LIMIT:-}" ]; then
	limit=$(printf '%s' "$MAX_UPLOAD_BYTES" | awk '
		{
			s = tolower($0)
			gsub(/[ \t]/, "", s)
			if (match(s, /^[0-9]+(\.[0-9]+)?/) == 0) exit 1
			n = substr(s, 1, RLENGTH) + 0
			u = substr(s, RLENGTH + 1)
			if (u == "" || u == "b") m = 1
			else if (u == "k" || u == "kb" || u == "kib") m = 1024
			else if (u == "m" || u == "mb" || u == "mib") m = 1048576
			else if (u == "g" || u == "gb" || u == "gib") m = 1073741824
			else if (u == "t" || u == "tb" || u == "tib") m = 1099511627776
			else if (u == "p" || u == "pb" || u == "pib") m = 1125899906842624
			else exit 1
			printf "%.0f", n * m
		}') || limit=''
	if [ -n "$limit" ]; then
		export BODY_SIZE_LIMIT="$limit"
	fi
else
	export BODY_SIZE_LIMIT
fi

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
