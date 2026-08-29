# syntax=docker/dockerfile:1.7
# One image, two deployment targets: Dokploy (Application) and plain docker compose.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- dependencies ------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# --- build -------------------------------------------------------------------
FROM deps AS build
COPY . .
# svelte-check runs here on purpose: a type error must fail the image, not production.
RUN pnpm run check && pnpm run build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm prune --prod

# --- runtime -----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
RUN apk add --no-cache tini curl \
	&& addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/build ./build
COPY --from=build --chown=app:app /app/node_modules ./node_modules
# Migrations are applied by the app at startup, so they must ship with it.
COPY --from=build --chown=app:app /app/drizzle ./drizzle
COPY --chown=app:app package.json ./
# The licence travels with the thing it licenses: an image is a distribution, and PolyForm's
# Notices section asks that whoever gets a copy gets the terms with it.
COPY --chown=app:app LICENSE ./
# chmod explicitly: a checkout from Windows carries no executable bit.
COPY --chown=app:app --chmod=755 deploy/entrypoint.sh ./entrypoint.sh

# Uploaded archives are streamed to a temp file before extraction; keep it writable
# and off the image layer.
RUN mkdir -p /tmp/pagebox && chown app:app /tmp/pagebox
ENV PAGEBOX_TMP_DIR=/tmp/pagebox

USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
	CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
