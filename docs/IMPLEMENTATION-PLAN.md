# PageBox — plan de implementación

> Complementa a `PLAN-static-hosting.md` (brief de diseño, en este mismo directorio). Este documento fija **stack
> concreto, estructura de repo, contrato de despliegue y milestones ejecutables**.
> Objetivo primario de entrega: **desplegable en Dokploy (Application/Dockerfile) desde el
> día 1**, y **desplegable con `docker compose up` en cualquier host** sin depender de la
> infra del homelab.

---

## Estado: 0.1.0 publicada (2026-08-29)

**M0–M7 completos.** M8 (homelab definitivo, 3 sitios reales) es despliegue, no código: la
imagen está en `ghcr.io/alexadiaconitei/pagebox` y la ruta de Dokploy está en
`docs/dokploy.md`.

Cerrado en esta última vuelta, además de las decisiones de §8:

- **M5** — rotación y revocación de deploy tokens desde el panel, `last_used_at` por token,
  rollback a un clic (mover el puntero con `activate`), `audit_log` filtrable.
- **M7** — el §10 del brief vive como suite (`tests/integration/hardening.test.ts`) y corre
  en CI junto a la integración real contra Postgres + MinIO; retención por sitio; README con
  capturas; sitio de documentación en `gh-pages/`; imagen publicada y verificada antes de
  publicarse.

### Historial: M0 → M4 + M6 implementados (2026-08-17)

### M6 — drag & drop en el panel

106 tests (66 unitarios + 40 de integración). Un solo camino de ingesta: el endpoint de
deployments acepta bearer **o** sesión de panel, con las mismas guardas.

- Preflight en cliente (`src/lib/preflight.ts`, puro y testeado): raíz adivinada cuando
  todo cuelga de una carpeta, falta `index.html`, referencias absolutas de raíz con las
  rutas que van a 404, generador detectado con **su línea de config exacta** ya sustituida,
  caps, y exclusión de dotfiles/`.git`/`node_modules`.
- Empaquetado en navegador con `fflate` en modo *store*: ratio 1:1, así que un build
  legítimo nunca dispara el guard de zip-bomb del servidor.
- Los avisos bloqueantes exigen un check explícito de responsabilidad; se guardan en
  `deployment.warnings` con `acknowledged_at`. PageBox despliega igualmente — no adivina ni
  reescribe HTML.
- **Verificación posterior**: tras activar se relee el `index.html` desplegado desde S3 y se
  comprueban los ficheros que referencia; el número de rotos sale en la lista y en la
  respuesta de la API (`brokenAssets`). Test: un `index.html` que apunta a `missing.js`
  reporta 1.

### Cambio posterior: tokens y throttling con better-auth

A petición explícita, los deploy tokens y el rate limiting dejan de ser código propio:

- **Tokens = api keys** de `@better-auth/api-key` (paquete aparte, versión 1.6.26 para
  casar con el pin de better-auth). El plugin genera, hashea, caduca, habilita/deshabilita
  y limita **por clave**; PageBox solo guarda a qué sitio puede desplegar la clave, en su
  `metadata`. Tabla `deploy_token` eliminada, `apikey` en su lugar.
  Token pasado de vueltas → **429**, no 401: CI debe reintentar, no rotar credenciales.
- **Throttling = el de better-auth**, con contadores en Postgres (`rate_limit`). Como su
  limiter está en el pipeline del handler, las llamadas de credenciales van ahora **a
  través de `auth.handler`** en proceso (`src/lib/server/auth/credentials.ts`) sin montar
  las rutas. Verificado: 12 intentos → 10 pasan, 2 devuelven 429, y con
  `API_KEY_MAX_REQUESTS=3` una key hace 3 llamadas y luego 429.
- **Arista que mordió a los propios tests:** better-auth no se fía de la IP del socket
  cuando le has dicho que lea una cabecera, así que **sin `X-Forwarded-For` todos comparten
  un cubo** y un atacante bloquea el login de todos. Se rellena desde la conexión cuando el
  proxy no lo puso, y los tests simulan proxy con su propia IP.
- `scripts/create-deploy-token.mjs` eliminado: los tokens se emiten desde el panel, que es
  además el camino que ahora ejercitan los tests.

### M4 — sitios privados

85 tests (44 unitarios + 41 de integración). El test de acceso privado da de alta un lector
por el panel, le concede el grant, lee el sitio con sesión `pb_view`, retira el grant y
comprueba que deja de servir.

- Autorización **por fichero**, no solo del HTML: granted → contenido; con sesión y sin
  grant → 404; anónimo navegando → 302 a `/login?next=…`; anónimo pidiendo un sub-recurso
  → **401 seco** (un 302 a un `<script src>` llega como HTML donde se esperaba código).
- Toda respuesta de sitio privado —incluidos 404, 401 y redirects— lleva
  `private, no-store` + `CDN-Cache-Control: no-store` + `Vary: Cookie`.
- Los sitios públicos no pagan lookup de sesión: es el hot path.

**Hallazgo:** el rate limit de better-auth vive en su handler HTTP, y llamando
`auth.api.*` se lo salta — **el login estaba sin límite** (12 contraseñas erróneas
seguidas, las 12 respondidas). Resuelto después con el propio limiter de better-auth (ver
abajo).

**Compromiso documentado:** un anónimo puede deducir que un sitio privado *existe* porque
recibe redirect al login en vez de 404. Ocultarlo obligaría a devolver 404 al lector
legítimo, que es lo que hace el sitio inusable. Con sesión y sin grant no se filtra nada.

### M3 — auth y panel

Criterio de aceptación comprobado end-to-end: el superadmin crea `ana@example.com`, esa
cuenta entra, se le fuerza el cambio de la contraseña de entrega, ve **"No sites yet"**,
recibe `/users` como **404**, y solo tras el grant aparece `demo-api` con rol `deployer`;
un sitio sin grant sigue siendo 404 para ella. 75 tests (42 unitarios + 33 de integración).

- Dos instancias de better-auth sobre las mismas tablas (`pb_admin` / `pb_view`), con
  `session.scope` validado contra el host y auditado si no coincide.
- Panel: sites (crear, ajustes, visibilidad), deployments (activar, rollback, borrar),
  grants a usuarios y grupos, tokens de deploy emitidos y revocados desde la UI, usuarios
  (crear, suspender, rol, reset de contraseña), grupos y registro de actividad.
- `perms.ts`: permisos efectivos de §4 con cache de 60 s invalidada en cada cambio.
- Diseño: consola densa (tablas de línea fina, monoespaciada para lo copiable, iconos
  lucide, un solo acento reservado al deployment vivo), claro y oscuro.

**Dos cosas que cambiaron al montarlo:**

| Punto | Qué pasó |
| --- | --- |
| CSRF | El check de SvelteKit compara `Origin` contra una URL reconstruida con headers de proxy: sin `x-forwarded-proto` todo POST del panel era 403, y `trustedOrigins` no acepta hostnames de runtime. Ahora se comprueba en `hooks.server.ts` contra `PAGEBOX_ADMIN_HOST`/`PAGEBOX_SITES_HOST` (hostname, ignorando esquema y puerto). |
| `/api/*` | Quedaba detrás de la puerta de sesión → un token válido recibía 303 al login, que un `curl` de CI lee como éxito. Exento explícitamente; el API responde su propio 401. |

Además: el plugin `admin` de better-auth rechaza roles que no estén declarados, así que
`superadmin` y `user` se definen sobre `createAccessControl`.

### M2 — API de despliegue

Verificado contra el stack real: 11 tests de integración de API + 8 unitarios de guardas
del zip (66 tests en total), más `scripts/verify-real-build.mjs`, que construye un sitio
Vite real con el `basePath` que devuelve `/whoami`, lo despliega por API y comprueba que
**todas** las referencias del HTML servido resuelven 200.

- `whoami`, `POST/GET deployments`, `activate` (rollback), `GET/DELETE` de un deployment.
- Guardas §6.4 comprobadas *durante* la lectura: zip-slip (incluida la que detecta yauzl,
  mapeada a su `reason` real), rutas absolutas, symlinks, cap de ficheros, cap de bytes
  descomprimidos y ratio. Cada rechazo devuelve su `reason`.
- Tokens `pbx_` solo hasheados; un token de otro sitio recibe **404**, no 403.
- Reutilización por checksum: subir el mismo archivo dos veces no duplica objetos.
- Barrido de deployments `uploading` colgados al arrancar y cada hora.
- Documentado en `docs/deploy-api.md`, con el workflow de GitHub Actions.

**Pendiente de M2 que se mueve a M3/M6:** emisión de tokens desde el panel (ahora
`scripts/create-deploy-token.mjs`).

### M1 — servido desde S3

Verificado con `scripts/seed-demo.mjs` (10 ficheros a MinIO) y 13 tests de integración
(`PAGEBOX_E2E_BASE=... pnpm test`), 48 tests en total:

- las 6 reglas de §5 (exacto, `.html`, `/index.html`, índice de directorio, shell de SPA,
  `404.html` con status 404) y el 301 de barra final;
- `Content-Type` por tabla propia, `nosniff`, `ETag`/304, `Range` → 206 con
  `Content-Range`, `HEAD`, 405 para el resto de métodos;
- `.br`/`.gz` por negociación, con cache negativa por deployment; `Range` desactiva la
  negociación;
- cache: assets con hash `immutable`, HTML y 404 `no-cache`, sitio privado
  `private, no-store` + `CDN-Cache-Control` en **todas** las respuestas, incluidos 404;
- dotfiles, `__pb/*` y traversal → 404; sitios privados → 404 hasta M4.

**Decisión tomada en M1:** un sitio `private` no se sirve a nadie hasta que existan sesiones
y grants (M4). Es la lectura segura de "privado" mientras no hay a quién autorizar.

### M0 — esqueleto desplegable

Verificado con el stack real (`docker compose up -d`, imagen construida desde el
`Dockerfile`):

- migraciones aplicadas al arrancar, bucket `pagebox` creado solo, superadmin de bootstrap
  creado con `must_change_password`;
- `/healthz` → `{"status":"ok","db":true,"s3":true,...}`; el contenedor llega a `healthy`;
- dispatch por host: `pagebox.localhost` → panel, `pages.localhost` → host de sitios,
  cualquier otro Host → 404, `/s/...` en el host de admin → 404;
- `/s/demo` → 301 a `/s/demo/`; sitio sin deployment activo → 404;
- `PAGEBOX_ADMIN_HOST == PAGEBOX_SITES_HOST` → el contenedor **muere con exit 1** y mensaje
  explícito;
- 16 tests unitarios (config + parseo de rutas) y `svelte-check` sin errores.

### Desviaciones respecto a lo planificado en §2–§4

| Punto                       | Plan original                             | Real                                                                                                                                                                                                          |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scripts de arranque         | `build/scripts/*.js` bundleados (esbuild) | Ejecutados **dentro del proceso**, en `init` de SvelteKit (`src/lib/server/startup.ts`). Menos piezas, mismo resultado; el entrypoint solo exporta env y lanza `node build/index.js`.                          |
| Singletons                  | creados al importar                       | `lazy()` (`src/lib/server/lazy.ts`): `vite build` importa todos los módulos server, y una máquina de build no tiene DB, S3 ni env. Sin esto el build fallaba.                                                  |
| `/healthz`                  | ruta normal                               | Además se responde **antes del dispatch de host** cuando la petición llega por IP (Docker HEALTHCHECK, Dokploy), con cuerpo reducido. Sin esto el healthcheck del contenedor nunca pasaba de `starting` → 404. |
| Lint                        | eslint + prettier                         | Solo prettier + `svelte-check`. eslint se puede añadir sin fricción; no aporta a M0.                                                                                                                            |
| better-auth                 | `^1.6.29`                                 | Pinneado a **1.6.26**: 1.6.27–1.6.29 arrastran `better-call@1.4.0`, que exige `@better-auth/utils@^0.5.0`, versión **no publicada** → la instalación falla. Revisar al actualizar.                              |
| Hash de contraseñas         | argon2id                                  | El default real de better-auth es **scrypt**. Se puede cambiar a argon2id en M3 vía `emailAndPassword.password.hash`.                                                                                          |
| Drizzle                     | 0.45.x estable                            | Confirmado 0.45.2 (API legacy `relations()`, no la v1 RC).                                                                                                                                                     |
| `pnpm.onlyBuiltDependencies` | en `package.json`                        | pnpm 11 lo ignora ahí: va en `pnpm-workspace.yaml` (`allowBuilds:`), generado por `pnpm approve-builds --all`.                                                                                                  |

---

## 0. Objetivo de despliegue (lo que condiciona todo lo demás)

Dos perfiles soportados desde M0, con el **mismo Dockerfile** y la misma imagen:

| Perfil                    | Servicios externos                                    | Cómo se despliega                         |
| ------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| **A — Dokploy (homelab)** | Postgres de `core`, Valkey de `core`, Garage S3       | Application (Dockerfile) + 2 × Add Domain |
| **B — Standalone**        | ninguno: el compose levanta Postgres + Valkey + MinIO | `docker compose up -d`                    |

Consecuencias de diseño, no negociables:

1. **Todo servicio externo es opcional o autoconfigurable.** Valkey opcional (fallback a
   cache en memoria del proceso). El bucket S3 se crea al arrancar si no existe (funciona
   igual con Garage y con MinIO).
2. **Las migraciones corren en el arranque del contenedor**, con advisory lock de Postgres.
   Dokploy no tiene "release phase"; un job separado sería un camino distinto por perfil.
3. **El superadmin se crea en el arranque** si la tabla `user` está vacía y hay
   `BOOTSTRAP_ADMIN_EMAIL/PASSWORD`, con `must_change_password = true`.
4. **Cero rutas hardcodeadas a la red del homelab.** `S3_ENDPOINT`, `DATABASE_URL`, etc.
   siempre por env; los defaults del `.env.example` apuntan a los servicios del compose.
5. **Healthcheck real** en `/healthz` (chequea DB + S3, no devuelve 200 fijo) para que
   Dokploy y `depends_on: condition: service_healthy` funcionen.

---

## 1. Revisión del brief: hallazgos que cambian la implementación

Ordenados por impacto. Nada de esto invalida el diseño; son cosas que rompen en la práctica
si no se resuelven antes de escribir código.

### 1.1 Bloqueantes reales

| #   | Hallazgo                                                                                                                                                                                                                                                                                                                                           | Efecto                                                                                                                | Resolución                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **`adapter-node` limita el body a 512 KB por defecto** (`BODY_SIZE_LIMIT`).                                                                                                                                                                                                                                                                        | Todo upload de deployment falla con 413 antes de llegar a tu código.                                                  | `BODY_SIZE_LIMIT` derivado de `MAX_UPLOAD_BYTES` en el entrypoint; test que sube 5 MB en M2.                                                                                                                                                                                                                                                                        |
| B2  | **Cloudflare Tunnel/proxy limita el body a 100 MB en planes no Enterprise.** El brief fija cap de 200 MB.                                                                                                                                                                                                                                          | Builds de 100–200 MB fallan _solo en producción_, con un 413 de Cloudflare que no aparece en local.                   | `MAX_UPLOAD_BYTES` default **100 MB**; documentar que subir de ahí exige plan CF o bypass del túnel. El cap del navegador (§6.3) baja a ~90 MB.                                                                                                                                                                                                                     |
| B3  | **`adapter-node` construye `event.url` desde `ORIGIN` o desde headers.** Con `ORIGIN` fijo, _los dos hosts colapsan en uno_ → el dispatch por `event.url.host` deja de funcionar y la protección CSRF de SvelteKit compara contra el origen equivocado.                                                                                            | El split de hosts (D1), que es la barrera de seguridad #1, se anula en silencio.                                      | **No usar `ORIGIN`.** `PROTOCOL_HEADER=x-forwarded-proto`, `HOST_HEADER=x-forwarded-host`, `ADDRESS_HEADER=x-forwarded-for`, `XFF_DEPTH` correcto. Y `assert(url.host ∈ {ADMIN_HOST, SITES_HOST})` en el hook, antes de nada: cualquier otro Host → 404 seco. Las URLs absolutas siguen construyéndose con `PAGEBOX_PUBLIC_SCHEME` + host de config (§9 del brief). |
| B4  | **better-auth no sirve dos sesiones con semántica distinta out-of-the-box.** El brief pide `pb_admin` y `pb_view` con TTL y alcance distintos.                                                                                                                                                                                                     | Si se implementa con una sola instancia, un token de lectura vale como token de panel al replantarlo en el otro host. | Dos instancias better-auth sobre **las mismas tablas**, con `advanced.cookiePrefix`/nombre de cookie distintos, y campo adicional **`scope: 'admin'\|'view'` en `session`**. El hook valida `session.scope == hostKind`; si no coincide → sesión inválida (y `audit_log`).                                                                                          |
| B5  | **`spa_fallback` + sitios privados + cache**: el brief exige `private, no-store` para todo asset privado, pero Cloudflare cachea por defecto extensiones estáticas (`.js`, `.css`, `.png`) **ignorando `Cache-Control` en algunos casos** salvo que la respuesta lleve `Cache-Control: private/no-store` _y_ no haya Cache Rule que fuerce cacheo. | Es el fallo #1 que el propio brief señala.                                                                            | Además de las cabeceras: en sitios privados emitir `CDN-Cache-Control: no-store` y `Cloudflare-CDN-Cache-Control: no-store`, y test de integración que hace `curl -I` sobre HTML y sobre `.js` (M4).                                                                                                                                                                |

### 1.2 Ajustes de alcance para que el perfil B (compose) sea real

| #   | Punto                                                          | Ajuste                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | El brief asume Postgres, Valkey y Garage ya provisionados.     | El compose los trae. `S3_*` por defecto → MinIO del compose; `forcePathStyle: true` sirve para ambos.                                                                                                                                                                                                                                                               |
| A2  | "Valkey opcional en v1" sin decir qué pasa sin él.             | Interfaz `CacheStore` con dos impls: `MemoryCache` (default, TTL + LRU) y `ValkeyCache` (si `REDIS_URL`). La invalidación por evento se convierte en pub/sub solo en el modo Valkey; en memoria basta el TTL de 60 s, porque hay un solo proceso. **Escalar a >1 réplica exige Valkey** → chequeo de arranque: si `PAGEBOX_REPLICAS>1` sin `REDIS_URL`, no levanta. |
| A3  | Dos hostnames en un despliegue local.                          | El compose incluye Traefik opcional (`profiles: [proxy]`) con las dos reglas Host, y el `.env.example` documenta el `hosts` file (`pagebox.localhost`, `pages.localhost`, que resuelven solos en la mayoría de sistemas). Sin Traefik, se puede probar con `curl -H "Host: ..."` contra `localhost:3000`.                                                           |
| A4  | Gotcha Dokploy Compose (los Compose no rutean por Add Domain). | El repo trae **`docker-compose.dokploy.yml`** (solo app, servicios por env) _y_ un `traefik-dynamic.example.yml`, pero la vía recomendada y documentada es **Application/Dockerfile**.                                                                                                                                                                              |

### 1.3 Correcciones menores al brief

- **§5 regla 6 (`404.html`)**: hay que fijar que el 404 del sitio se sirve con
  `Cache-Control: no-cache` incluso en sitios públicos; si no, un 404 cacheado en el edge
  sobrevive al deploy que crea esa ruta.
- **§5 `Range`**: hay que pasar el `Range` a S3 (`GetObjectCommand.Range`) y devolver 206 +
  `Content-Range`, no leer el objeto entero. Con `.br`/`.gz` precomprimidos, **`Range` y
  `Content-Encoding` no se combinan**: si hay `Range`, servir el original sin comprimir.
- **§6.2**: `POST /deployments` con `Content-Type: application/zip` y el zip en el body va
  bien para CI, pero **el estado `uploading` necesita expiración**: un deployment que muere
  a medias deja basura en S3. Job de limpieza (`deployment.status='uploading'` +
  `created_at < now()-1h` → borrar prefijo en S3, marcar `failed`).
- **§4**: falta `user.must_change_password` (el brief lo pide en §9 con
  `BOOTSTRAP_ADMIN_PASSWORD`) y `deployment.checksum` (sha256 del zip, para idempotencia de
  reintentos del CI).
- **§10**: añadir a la checklist "el `Host` no reconocido → 404" y "`session.scope` validado
  contra el host".

---

## 2. Decisiones cerradas de stack

| Capa       | Elección                                                                     | Nota                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Runtime    | Node **22 LTS**, `node:22-alpine`                                            | Multi-stage, usuario no root, `--enable-source-maps` off en prod.                                                         |
| Gestor     | **pnpm** (corepack)                                                          | Lockfile en repo; cache de capa en el Dockerfile.                                                                         |
| Framework  | **SvelteKit 2 + Svelte 5**, `adapter-node`                                   | Panel + API + hot path de assets.                                                                                         |
| UI         | **Tailwind v4** + componentes propios                                        | Sin design system pesado: el panel son tablas y formularios.                                                              |
| DB         | **Postgres 16**, **Drizzle `0.45.x` (estable, no el RC v1)** + `drizzle-kit` | Migraciones SQL versionadas en `drizzle/`.                                                                                |
| Driver     | **`postgres`** (postgres.js)                                                 | Pool pequeño (`max: 10`); `prepare: false` no hace falta (sin pgbouncer en modo transaction... si lo hubiera, activarlo). |
| Auth       | **better-auth** + plugin `admin`, dos instancias (§1.1 B4)                   | argon2id por defecto.                                                                                                     |
| Cache      | `CacheStore` → memoria \| Valkey (`iovalkey`)                                | §1.2 A2.                                                                                                                  |
| S3         | `@aws-sdk/client-s3` v3, `forcePathStyle: true`                              | Garage y MinIO.                                                                                                           |
| Zip        | **`yauzl`** (servidor, streaming) + **`fflate`** (cliente, modo _store_)     | §6.4 del brief.                                                                                                           |
| Validación | **zod** (env, payloads de API, forms)                                        | Un solo esquema de env, parseado al arrancar.                                                                             |
| IDs        | **ULID** (`ulidx`) para deployments; `nanoid`/ULID para el resto             | Ordenables por tiempo.                                                                                                    |
| Tests      | **vitest** (unit + integración) + **Playwright** (e2e panel, M6)             | Integración contra el compose de test.                                                                                    |
| Lint       | eslint + prettier + `svelte-check`                                           | En CI y en el build de Docker (fail fast).                                                                                |

**Descartado explícitamente**: Bun (Dokploy-friendly pero menos rodado en el hot path de
streams), Prisma (migraciones menos transparentes para este caso), auth propia.

---

## 3. Estructura del repo

```
pagebox/
├─ Dockerfile                      # multi-stage, produce la imagen única
├─ docker-compose.yml              # perfil B: app + postgres + valkey + minio (+ traefik opcional)
├─ docker-compose.dokploy.yml      # perfil A alternativo (servicios externos por env)
├─ deploy/
│  ├─ entrypoint.sh                # migrate → ensure-bucket → bootstrap-admin → node build
│  ├─ traefik-dynamic.example.yml  # solo si se usa el modo Compose en Dokploy
│  └─ dokploy.md                   # guía paso a paso del perfil A
├─ drizzle/                        # migraciones .sql + meta
├─ .env.example
├─ src/
│  ├─ hooks.server.ts              # dispatch por host: sites | admin | 404
│  ├─ lib/server/
│  │  ├─ config.ts                 # zod env, fail-fast (ADMIN_HOST != SITES_HOST)
│  │  ├─ db/{index.ts,schema.ts,migrate.ts}
│  │  ├─ auth/{admin.ts,view.ts,shared.ts}
│  │  ├─ s3.ts                     # cliente + ensureBucket + get/put/head/range
│  │  ├─ cache/{index.ts,memory.ts,valkey.ts}
│  │  ├─ sites/
│  │  │  ├─ resolve.ts             # resolveSite(host, path)  ← punto único (D1)
│  │  │  ├─ serve.ts               # las 6 reglas de §5 + cache + headers
│  │  │  ├─ mime.ts                # tabla propia de Content-Type
│  │  │  └─ guards.ts              # dotfiles, /__pb/*, nosniff, SW header
│  │  ├─ perms.ts                  # permisos efectivos + cache de grants
│  │  ├─ deploy/
│  │  │  ├─ ingest.ts              # body → temp → validate → S3 → activate
│  │  │  ├─ zip.ts                 # yauzl + guardas §6.4
│  │  │  └─ verify.ts              # verificación posterior (§6.3)
│  │  ├─ audit.ts
│  │  └─ ratelimit.ts
│  ├─ lib/client/                  # dropzone, preflight (§6.3), fflate
│  └─ routes/
│     ├─ (admin)/                  # panel: sites, users, groups, audit, help/deploy
│     ├─ (sites)/                  # login/logout/healthz del host de sitios
│     └─ api/v1/                   # whoami, deployments, activate, ...
└─ tests/
   ├─ unit/                        # resolve, mime, perms, zip guards
   ├─ integration/                 # contra compose de test (pg + minio)
   └─ e2e/                         # Playwright (M6)
```

**Repo propio** (respuesta a §11.3 del brief): sí. Este directorio _es_ PageBox. La guía de
despliegue del homelab vive en `deploy/dokploy.md` aquí, y el repo de infra solo referencia.

---

## 4. Contrato de despliegue (M0, se escribe antes que la lógica)

### 4.1 Dockerfile (esqueleto)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm run check && pnpm run build && pnpm prune --prod

FROM base AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache tini curl && addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/build ./build
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/drizzle ./drizzle
COPY --chown=app:app package.json deploy/entrypoint.sh ./
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/sbin/tini","--","./entrypoint.sh"]
```

Notas: `pnpm run check` incluye `svelte-check` + eslint → un fallo de tipos no llega a
producción. La imagen final no lleva ni fuentes ni devDependencies.

### 4.2 `entrypoint.sh`

```sh
#!/bin/sh
set -eu
export BODY_SIZE_LIMIT="${BODY_SIZE_LIMIT:-$MAX_UPLOAD_BYTES}"
node build/scripts/migrate.js        # drizzle migrate + advisory lock
node build/scripts/ensure-bucket.js  # crea bucket si falta (Garage/MinIO)
node build/scripts/bootstrap.js      # superadmin si no hay usuarios
exec node build/index.js
```

Los tres scripts son idempotentes y salen 0 si no hay nada que hacer. Si cualquiera falla,
el contenedor no arranca (mejor que arrancar a medias).

### 4.3 `docker-compose.yml` (perfil B, resumen)

```yaml
services:
  app:
    build: . # o image: ghcr.io/<owner>/pagebox:latest
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }
      minio: { condition: service_healthy }
    ports: ['3000:3000'] # detrás de proxy propio, o usar el profile traefik
    restart: unless-stopped
  postgres:
    image: postgres:16-alpine
    environment: [POSTGRES_USER=pagebox, POSTGRES_PASSWORD=..., POSTGRES_DB=pagebox]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ['CMD-SHELL', 'pg_isready -U pagebox'], interval: 5s, retries: 20 }
  valkey:
    image: valkey/valkey:8-alpine
    profiles: [cache]
    volumes: [valkeydata:/data]
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    volumes: [miniodata:/data]
    healthcheck: { test: ['CMD', 'mc', 'ready', 'local'], interval: 5s, retries: 20 }
  traefik:
    image: traefik:v3
    profiles: [proxy]
    # labels en app: Host(`${PAGEBOX_ADMIN_HOST}`) y Host(`${PAGEBOX_SITES_HOST}`)
volumes: { pgdata: {}, valkeydata: {}, miniodata: {} }
```

`docker compose up -d` → stack mínimo. `--profile cache --profile proxy` → completo.

### 4.4 Dokploy (perfil A, la vía recomendada)

1. Proyecto `app-pagebox` → **Create Application** → source: repo Git → Build type
   **Dockerfile**.
2. **Add Domain** ×2: `pagebox.<dominio>` y `pages.<dominio>`, ambos al puerto 3000. Sin
   ficheros dinámicos de Traefik.
3. Env: las de §4.5. `DATABASE_URL` desde `provision-pg.sh pagebox`; `S3_*` apuntando a
   Garage (`http://192.168.1.197:3900`, `S3_FORCE_PATH_STYLE=true`); `REDIS_URL` opcional.
4. Cap de body en Traefik (middleware `buffering.maxRequestBodyBytes`) ≥ `MAX_UPLOAD_BYTES`.
5. Health check de Dokploy → `/healthz`.
6. **CF Access**: si se pone delante del panel, añadir bypass para `/api/v1/*` o service
   tokens en el CI (§9 del brief). Nunca delante del host de sitios.

### 4.5 Variables de entorno (contrato final)

```bash
# --- hosts (la app NO arranca si coinciden) ---
PAGEBOX_ADMIN_HOST=pagebox.localhost
PAGEBOX_SITES_HOST=pages.localhost
PAGEBOX_SITES_PREFIX=/s
PAGEBOX_PUBLIC_SCHEME=http            # https detrás del túnel
PAGEBOX_REPLICAS=1                    # >1 exige REDIS_URL

# --- infra ---
DATABASE_URL=postgres://pagebox:pagebox@postgres:5432/pagebox
REDIS_URL=                            # vacío → cache en memoria
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=... S3_SECRET_KEY=...
S3_BUCKET=pagebox
S3_FORCE_PATH_STYLE=true

# --- auth ---
AUTH_SECRET=                          # 32+ bytes; sin default, la app no arranca sin él
BOOTSTRAP_ADMIN_EMAIL=
BOOTSTRAP_ADMIN_PASSWORD=

# --- límites ---
MAX_UPLOAD_BYTES=104857600            # 100 MB (límite de Cloudflare, §1.1 B2)
MAX_UNCOMPRESSED_BYTES=524288000
MAX_FILES=20000
MAX_ZIP_RATIO=100

# --- adapter-node (los fija el entrypoint; documentados por si se sobreescriben) ---
BODY_SIZE_LIMIT=                      # = MAX_UPLOAD_BYTES
PROTOCOL_HEADER=x-forwarded-proto
HOST_HEADER=x-forwarded-host
ADDRESS_HEADER=x-forwarded-for
XFF_DEPTH=1                           # 2 con Cloudflare + Traefik

# --- v2, sin efecto ---
PAGEBOX_BASE_DOMAIN=
PAGEBOX_SUBDOMAIN_MODE=false
```

`src/lib/server/config.ts` parsea esto con zod **una vez, al importar**, y lanza si:
`ADMIN_HOST == SITES_HOST`, falta `AUTH_SECRET`, `REPLICAS>1` sin `REDIS_URL`, o
`MAX_UPLOAD_BYTES > MAX_UNCOMPRESSED_BYTES`.

---

## 5. Diseño de los módulos que deciden el resto

### 5.1 `hooks.server.ts` — dispatch por host

```ts
const handle: Handle = async ({ event, resolve }) => {
	const kind = hostKind(event.url.host); // 'admin' | 'sites' | null
	if (!kind) return new Response('Not found', { status: 404 });
	event.locals.hostKind = kind;

	if (kind === 'sites') {
		// El host de sitios NO entra al router salvo para su superficie mínima (§7 del brief)
		const hit = resolveSite(event.url.host, event.url.pathname);
		if (hit) return serveSite(event, hit); // devuelve Response directa
		if (!SITES_ALLOWED_PATHS.has(event.url.pathname)) return notFound();
	} else {
		if (event.url.pathname.startsWith(SITES_PREFIX)) return notFound();
	}
	return resolve(event);
};
```

Sirviendo assets fuera del router se evita el coste de matching de rutas por asset y, más
importante, **se hace imposible que una ruta del panel quede alcanzable desde el host de
sitios por descuido** (la lista blanca es explícita).

### 5.2 `resolveSite` — punto único (D1 del brief)

Firma congelada desde M1: `(host, path) => { site, subpath } | null`. v1 solo implementa la
rama de path; la rama de subdominio (v2) entra sin tocar `serveSite`.

### 5.3 `serveSite` — orden fijo

`guards` → `perms` (cache) → `resolución de subpath` (6 reglas §5) → `S3 get/head` →
`headers` (mime propio, nosniff, ETag/304, Range, encoding) → `cache policy`
(público/privado). La política de cache es **la última** en aplicarse y la de sitio privado
**sobrescribe siempre** (§1.1 B5).

### 5.4 Permisos y cache

`effectivePermission(user|null, site)` implementa la tabla de §4 del brief. Cacheado por
`(siteId, userId|anon)` con TTL 60 s. Invalidación: al tocar grants/visibilidad/grupos se
emite un evento (`pubsub` en Valkey, `EventEmitter` en memoria) que purga las entradas del
sitio. El _fallback_ de correctitud es el TTL: nunca hay estado no expirable.

### 5.5 Ingesta de deployment

```
request.body (ReadableStream)
  → Readable.fromWeb → escritura a fichero temporal con corte a MAX_UPLOAD_BYTES
  → sha256 en streaming (idempotencia)
  → yauzl.open(random access) → por entrada: normalizar ruta, rechazar zip-slip/symlink,
    acumular bytes y ratio, abortar en cuanto se cruce un límite
  → PutObject por entrada a sites/<siteId>/<deploymentId>/<ruta>  (concurrencia 8)
  → status='ready' → (si activate) UPDATE site SET active_deployment_id
  → verify.ts opcional
```

El fichero temporal va a un `tmpfs`/`/tmp` del contenedor con espacio ≥ `MAX_UPLOAD_BYTES`;
se borra en `finally`. Nunca se descomprime a disco: cada entrada va de zip a S3 en stream.

---

## 6. Milestones ejecutables

Cada milestone termina con la app **funcionando y desplegable**. El criterio de aceptación
es el del brief §8 más el de despliegue.

| M                                | Contenido                                                                                                                                                                                                                                              | Criterio de aceptación                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 — Esqueleto desplegable**   | SvelteKit + Tailwind, `config.ts` fail-fast, Drizzle schema completo (§4 + `must_change_password`, `checksum`) + primera migración, `Dockerfile`, `entrypoint.sh`, ambos compose, `/healthz` real, dispatch de hosts, `.env.example`, CI de lint/test. | `docker compose up -d` levanta y `/healthz` da 200 con DB+S3 ok. Con `ADMIN_HOST==SITES_HOST` el contenedor **muere al arrancar**. Un Host desconocido → 404. Deploy real en Dokploy con los dos dominios.                                            |
| **M1 — Servir desde S3**         | `resolveSite`, `serve.ts` (6 reglas + 301 de barra final), `mime.ts`, guards, ETag/304, Range, `.br`/`.gz`.                                                                                                                                            | Deployment sembrado a mano visible en `/s/<slug>/`. Tests unitarios de las 6 reglas, del 301, de dotfiles y de `/__pb/*`.                                                                                                                             |
| **M2 — API de deploy + zip**     | `whoami`, `POST/GET deployments`, `activate`, `DELETE`, `zip.ts` con las 5 guardas, deploy tokens (`pbx_`, sha256, prefix), limpieza de `uploading` colgados.                                                                                          | Build real de Docusaurus **y** de Next export, construidos con el `basePath` de `whoami`, navegan sin un 404 de asset. Tests de zip-slip, zip-bomb, symlink, cap de ficheros. Test de upload de 5 MB (valida B1).                                     |
| **M3 — Auth + panel**            | better-auth ×2 instancias con `scope`, plugin `admin`, login en ambos hosts, rate limit, CSRF, panel: sites/users/groups, `must_change_password`.                                                                                                      | Superadmin crea usuario; ese usuario entra y solo ve sus sitios. Una cookie `pb_view` presentada como `pb_admin` → rechazada por `scope`.                                                                                                             |
| **M4 — Privados + grants**       | `perms.ts` + cache, política de cache privada, 404 vs 401 vs 302 según `Accept`.                                                                                                                                                                       | Anónimo → login; con sesión sin grant → 404; con grant → sitio y **todos** sus assets. Test: ningún response de sitio privado es cacheable (HTML y `.js`, incluidas cabeceras CDN). Sub-recurso sin sesión → 401.                                     |
| **M5 — Tokens, rollback, audit** | Rotación/revocación de tokens, `last_used_at`, rollback 1 clic, `audit_log` filtrable.                                                                                                                                                                 | GH Actions despliega end-to-end contra la instancia real; rollback verificado.                                                                                                                                                                        |
| **M6 — Drag & drop**             | Dropzone, preflight en cliente (§6.3, los 6 chequeos), `fflate` store, check de responsabilidad → `warnings`+`acknowledged_at`, `/help/deploy` parametrizada, `verify.ts`.                                                                             | Carpeta, `.zip` e `index.html` suelto despliegan. Soltar la carpeta contenedora → el preflight propone la raíz correcta. Build con rutas absolutas → aviso con la línea de config del generador. Subida por cookie sin CSRF → 403. E2E en Playwright. |
| **M7 — Endurecido + docs**       | Checklist §10 completa como suite de tests, README, `deploy/dokploy.md`, guía de compose, limpieza de deployments antiguos (retención N).                                                                                                              | La checklist de seguridad pasa en CI. Un tercero levanta el proyecto solo con el README.                                                                                                                                                              |
| **M8 — Homelab**                 | Despliegue definitivo, bucket Garage en la política de respaldo, 3 sitios reales.                                                                                                                                                                      | Los 3 sitios en marcha; rollback probado en producción.                                                                                                                                                                                               |

Orden alternativo si urge tener algo usable: M0 → M1 → M2 → M5 permite **desplegar sitios
públicos por CI** sin panel (auth por token). El panel (M3) y los privados (M4) llegan
después. Recomendado si el primer uso es "publicar mis docs ya".

---

## 7. Estrategia de tests

- **Unit (vitest)**: `resolveSite`, resolución de subpath, `mime`, `perms`, guardas de zip
  (con zips maliciosos generados en el propio test), parseo de env.
- **Integración (vitest + compose de test)**: Postgres + MinIO efímeros; ciclo completo
  upload → activar → servir → rollback. Aquí viven los tests de cabeceras (públicas vs
  privadas) y los de status (404/401/302).
- **Seguridad como test, no como checklist**: cada línea de §10 del brief es un `it()`. El
  de "sitio privado nunca cacheable" y el de "sub-recurso → 401" son los dos que no pueden
  faltar.
- **E2E (Playwright, M6)**: login, crear sitio, drag & drop de una carpeta, rollback.
- **CI**: lint + check + unit en cada push; integración en PR; build de imagen Docker en
  cada push a `main` (garantiza que el perfil de despliegue nunca se rompe en silencio).

---

## 8. Decisiones cerradas antes de 0.1.0

Las cuatro que quedaban abiertas, con lo que se hizo y dónde está.

1. **Cap de subida → 100 MB, configurable.** `MAX_UPLOAD_BYTES` por defecto 104857600 por
   la limitación de Cloudflare (§1.1 B2). El entrypoint propaga el mismo valor a
   `BODY_SIZE_LIMIT` de adapter-node, así que el cap de la app y el de HTTP no pueden
   divergir. Un build más grande sigue siendo caso de `s3-direct-upload` (presigned
   multipart), fuera de v1.
2. **CF Access delante del panel → no por defecto.** Rompe el API por token, que vive en el
   host de admin. Si se pone: política de bypass para `/api/v1/*` o service tokens en el
   workflow. Delante del host de sitios, nunca — los sitios públicos dejarían de serlo.
   Documentado en `docs/dokploy.md`.
3. **Retención → los N últimos por sitio, nunca por antigüedad.** Configurable por sitio,
   mínimo 2 (`MIN_RETENTION`), y el deployment activo no se poda esté donde esté en el
   orden. Por antigüedad se descartó: un sitio que no se despliega en meses no debe perder
   su historial por el paso del tiempo. `src/lib/server/deploy/retention.ts`.
4. **Registro de imagen → GHCR, y ambas vías.** `.github/workflows/release.yml` publica
   `ghcr.io/alexadiaconitei/pagebox` en cada tag `v*` (`{version}`, `{major}.{minor}` y
   `latest` si no es pre-release), tras arrancar la imagen contra Postgres + MinIO y
   comprobarla (`scripts/smoke-image.sh`) — lo que no responde no se publica. Los dos
   compose usan `image:` con `PAGEBOX_TAG`; Dokploy puede seguir compilando desde el repo
   (Application/Dockerfile) para forks o commits sin tag.
