#!/usr/bin/env bash
# Boots the built image against a throwaway Postgres and MinIO and asserts the four things
# that make an image publishable at all: it starts, it migrates, it splits the two hosts,
# and it answers with PageBox's own error page rather than the runtime's.
#
# Runs in the release workflow between building and pushing, so a broken image never
# reaches the registry.
#
#   bash scripts/smoke-image.sh ghcr.io/alexadiaconitei/pagebox:0.1.0
set -euo pipefail

IMAGE="${1:?usage: smoke-image.sh <image>}"
# The host port is only how this script reaches the container; SMOKE_PORT moves it out of
# the way of anything already listening on a workstation.
PORT="${SMOKE_PORT:-3000}"
NET=pagebox-smoke
ADMIN_HOST=pagebox.localhost
SITES_HOST=pages.localhost

cleanup() {
	docker rm -f pbx-smoke-app pbx-smoke-pg pbx-smoke-s3 >/dev/null 2>&1 || true
	docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
	echo "smoke: $1"
	echo '--- app log ---'
	docker logs pbx-smoke-app 2>&1 | tail -40 || true
	exit 1
}

docker network create "$NET" >/dev/null

docker run -d --name pbx-smoke-pg --network "$NET" \
	-e POSTGRES_USER=pagebox -e POSTGRES_PASSWORD=pagebox -e POSTGRES_DB=pagebox \
	postgres:16-alpine >/dev/null

docker run -d --name pbx-smoke-s3 --network "$NET" \
	-e MINIO_ROOT_USER=pagebox -e MINIO_ROOT_PASSWORD=pageboxpagebox \
	minio/minio:latest server /data >/dev/null

# The app creates the bucket itself and applies the migrations at boot, so there is no
# provisioning step here: if either is broken, /healthz never turns 200.
docker run -d --name pbx-smoke-app --network "$NET" -p "${PORT}:3000" \
	-e PAGEBOX_ADMIN_HOST="$ADMIN_HOST" \
	-e PAGEBOX_SITES_HOST="$SITES_HOST" \
	-e PAGEBOX_PUBLIC_SCHEME=http \
	-e DATABASE_URL=postgres://pagebox:pagebox@pbx-smoke-pg:5432/pagebox \
	-e S3_ENDPOINT=http://pbx-smoke-s3:9000 \
	-e S3_ACCESS_KEY=pagebox \
	-e S3_SECRET_KEY=pageboxpagebox \
	-e S3_BUCKET=pagebox \
	-e S3_FORCE_PATH_STYLE=true \
	-e AUTH_SECRET=smoke-only-secret-smoke-only-secret-smoke \
	-e BOOTSTRAP_ADMIN_EMAIL=smoke@example.com \
	-e BOOTSTRAP_ADMIN_PASSWORD=smoke-bootstrap-password \
	-e HOST_HEADER=x-forwarded-host \
	-e PROTOCOL_HEADER=x-forwarded-proto \
	"$IMAGE" >/dev/null

echo "smoke: waiting for /healthz"
for i in $(seq 1 60); do
	if curl -fsS http://127.0.0.1:${PORT}/healthz >/dev/null 2>&1; then
		echo "smoke: healthy after ${i}s"
		break
	fi
	[ "$i" = 60 ] && fail "never became healthy"
	sleep 1
done

# `accept: text/html` on purpose: the error path answers a sub-resource with plain text and
# only a navigation with the document, so without it this asserts against the wrong one of
# the two shapes.
status() {
	curl -s -o /tmp/pbx-smoke-body -w '%{http_code}' \
		-H "x-forwarded-host: $1" -H 'x-forwarded-proto: http' -H 'accept: text/html' \
		"http://127.0.0.1:${PORT}${2}"
}

# The panel host serves the panel — anonymous, so a redirect to the sign-in page is the
# right answer and -L must land on 200.
code=$(curl -s -o /dev/null -w '%{http_code}' -L \
	-H "x-forwarded-host: $ADMIN_HOST" -H 'x-forwarded-proto: http' http://127.0.0.1:${PORT}/)
[ "$code" = 200 ] || fail "panel host answered $code, expected 200"

# The sites host has no site at the root, and must answer with PageBox's own 404 document
# rather than adapter-node's one-line body.
code=$(status "$SITES_HOST" /s/does-not-exist/)
[ "$code" = 404 ] || fail "unknown site answered $code, expected 404"
grep -qi 'pagebox' /tmp/pbx-smoke-body || fail "404 body is not the PageBox error page"

# An unknown Host reaches neither surface.
code=$(status unknown.example.com /)
[ "$code" = 404 ] || fail "unknown host answered $code, expected 404"

# The bootstrap superadmin is created on first boot; without it a fresh instance has no
# way in at all.
docker logs pbx-smoke-app 2>&1 | grep -qi 'bootstrap' || fail "no bootstrap line in the boot log"

echo "smoke: ok — $IMAGE"
