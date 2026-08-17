# PageBox — plataforma propia de hosting estático con RBAC

> **Estado:** brief de diseño. Nada implementado. Documento pensado para arrancar una
> sesión nueva del agente con contexto completo.
> **Nombre `pagebox` = placeholder.** Renombra libremente antes de empezar.
> **v1 = routing por path.** Subdominio por sitio existe como v2 documentada (§12), no
> como deuda oculta.

---

## 1. Resumen: qué herramienta necesito

Un **PaaS de sitios estáticos self-hosted, multi-usuario**, equivalente a "Cloudflare
Pages + control de acceso", donde:

- Un **superadmin** crea usuarios, grupos y sitios desde una UI web.
- Cada **sitio** es un conjunto de ficheros ya construidos (`dist/`, `build/`, `out/`,
  un `index.html` suelto). La plataforma **no construye nada**: recibe artefactos.
- Cada sitio es **`public`** (cualquiera) o **`private`** (solo usuarios/grupos con
  grant explícito). Privado = privado de verdad: **cada asset** (`.js`, `.css`, `.png`)
  pasa por el chequeo de autorización, no solo el HTML.
- Se despliega por **API con token** desde GitHub Actions (`zip` del build), o
  **arrastrando la carpeta / el zip al panel** (§6.3).
- Deployments **inmutables** → rollback = cambiar un puntero.

Por qué construirla: no existe equivalente mantenido. **Meli** (getmeli/meli) era
exactamente esto — orgs/teams/users/sites, sitios con password — pero su último commit
es de **2023-03-15** y el README pide mantenedores. El resto del ecosistema es o SaaS
(static.app), o juguetes (<35★ en `github.com/topics/static-hosting`), o capas de auth
genéricas (Authelia/Authentik) que no gestionan sitios ni despliegues.

### Qué NO es (scope fuera)

- No es un generador de sitios ni un CMS. No hay build step en el servidor.
- No es un IdP genérico. Autentica **para sus propios sitios**, no protege terceros.
- No hay funciones serverless, edge workers, ni formularios.

---

## 2. Decisiones de arquitectura

### D1 — Routing v1: dos hostnames, sitios por path

```
https://pagebox.adiabox.es/          → panel de admin + API
https://pages.adiabox.es/s/<slug>/   → los sitios desplegados
```

Ambos hostnames son de **un solo nivel** → ya cubiertos por Universal SSL
(`apex + *.adiabox.es`) y por la regla de túnel `*.adiabox.es → Traefik :80`. Se declaran
como dos dominios normales en Dokploy. **Cero configuración de Cloudflare, cero router
catch-all en Traefik, cero DNS por sitio.**

**Ambos hostnames son configurables por quien despliega** (§9). `pagebox.` y `pages.`
son solo el default; otra instancia puede usar `panel.` + `static.`, o dos dominios
distintos. El código nunca asume literales.

#### Por qué dos hostnames y no uno

Los sitios alojados y el panel **no pueden compartir origen**. Si comparten, cualquier
HTML alojado puede hacer:

```js
fetch('/api/v1/sites/x/deploy-tokens', { credentials: 'include' });
```

y el navegador **adjunta la cookie de admin**. `HttpOnly` no protege de esto: el script no
lee la cookie, la usa. Escalada de privilegios desde contenido estático. Separando hosts,
`pages.` y `pagebox.` son orígenes distintos y esa petición sale sin credenciales.

**Arranque en fallo:** si `PAGEBOX_ADMIN_HOST == PAGEBOX_SITES_HOST`, la app **no
levanta**. No es un warning.

#### Lo que sigue costando (y hay que documentar al usuario)

1. **Sitio A y sitio B comparten origen entre sí** (`pages.adiabox.es`). A puede leer el
   `localStorage`/`sessionStorage` de B. Aceptable mientras todo el contenido sea de
   confianza. **Ese es el criterio exacto para migrar a v2**: el día que alojes un build
   que no controlas.
2. **El build va acoplado a su slug.** Hay que construir con `basePath = /s/<slug>/`.
   Reescribir URLs al vuelo es inviable (URLs generadas en JS, `fetch()`, source maps),
   así que no se intenta. Flujo: el CI pregunta al API por su slug antes de construir
   (§6, `GET /api/v1/whoami`).
3. **Un `index.html` suelto solo funciona con rutas relativas.** Si usa `/style.css`
   (absoluta de raíz), se rompe. `<base href>` arregla las relativas, **no** las
   absolutas. Limitación documentada, no resuelta.
4. Cambiar un sitio de path a subdominio (v2) **exige rebuild**, porque cambia el
   `basePath`.

#### Prefijo `/s/`, no `/<slug>/`

Deja la raíz de `pages.` libre para `/healthz`, `/__pb/*` y una landing. Elimina la
necesidad de una lista de slugs reservados.

#### Descartado ahora: subdominio por sitio (`<slug>.adiabox.es`)

Técnicamente funciona con el wildcard existente y un router catch-all de Traefik con
`priority: 1` (los `Host(...)` específicos siempre ganan, así que `db.`/`garage.`/`draw.`
no corren peligro). No se descarta por fragilidad ni por Cloudflare — Cloudflare ni se
entera, el wildcard ya está.

Se descarta por **blast radius**: ese router convierte a PageBox en el handler por defecto
de _todo_ subdominio no reclamado del dominio. Un bug en una app v1 pasa a ser un fallo de
resolución de toda la infra. Se reevalúa en §12.

#### Resolver único desde el día 1

Un solo punto de entrada, para que v2 sea una rama y no una reescritura:

```ts
resolveSite(host, path): { site, subpath } | null
  // v1
  host === SITES_HOST && path.match(/^\/s\/([a-z0-9][a-z0-9-]{1,40})(\/.*)?$/)
  // v2 (§12) — rama nueva, mismo contrato
  host.endsWith("." + BASE_DOMAIN) && lookupSiteByHostname(host)
```

Y `site.base_path` en la tabla (`/s/<slug>/` en v1, `/` en v2).

### D2 — Almacenamiento: Garage S3, deployments inmutables

Bucket único `pagebox`. Clave:

```
sites/<siteId>/<deploymentId>/<ruta/del/fichero>
```

`deploymentId` = ULID. Subir un deployment nunca toca el anterior. Activar =
`UPDATE site SET active_deployment_id = ?`. **Rollback = un UPDATE.** Deploy previews =
servir un `deploymentId` arbitrario bajo `/s/<slug>/~/<deployId>/` (v2).

Garage ya existe (LXC 101, `192.168.1.197:3900`). Provisión de bucket + key según
`PROVISIONING.md §S3`. Cliente: `@aws-sdk/client-s3` con **`forcePathStyle: true`**
(Garage no hace virtual-host style por defecto).

**Descartado — volumen en disco**: acopla los bytes al contenedor, complica backups y
mata cualquier futuro multi-nodo. Garage ya está y ya se respalda.

### D3 — Servido: la app hace de proxy y de guardia (todo por un solo camino)

PageBox lee de S3 y devuelve los bytes él mismo, **también para sitios públicos**.

Por qué no separar (nginx sirve público, app sirve privado): dos rutas de código = dos
semánticas de 404/redirect/`Content-Type` que divergen, y el endpoint web de Garage
(`:3902`) **no autentica nada** — si se filtra, el "privado" es público. Un solo camino,
una sola semántica.

El coste (Node en el hot path de cada asset) se mitiga con:

- Cache de metadatos de sitio + grants efectivos en **Valkey** (TTL 60s, invalidación por
  evento al editar permisos).
- `Cache-Control: public, max-age=31536000, immutable` en assets con hash
  (`/_next/static/*`, `/assets/*.[hash].*`) → **Cloudflare cachea en el edge** y la mayor
  parte del tráfico de sitios públicos ni llega al homelab.
- `ETag` (reutilizar el de S3) + `If-None-Match` → 304 baratos.

> ⚠️ Los sitios **privados** deben responder `Cache-Control: private, no-store` y
> `Vary: Cookie` **siempre**, HTML y assets. Si un asset privado se cachea en el edge de
> Cloudflare, queda accesible sin sesión. Es el fallo de seguridad #1 de este diseño;
> ponlo en un test.

### D4 — Sesión: una cookie por hostname, sin flujo SSO (ventaja del modo path)

Todos los sitios comparten el origen `pages.adiabox.es` ⇒ **una sola cookie de lectura
cubre todos los sitios privados**. No hay redirect SSO, ni JWT de corta vida, ni nonces.

| Cookie     | Host                 | Contenido         | TTL          |
| ---------- | -------------------- | ----------------- | ------------ |
| `pb_admin` | `PAGEBOX_ADMIN_HOST` | sesión del panel  | 30 d rolling |
| `pb_view`  | `PAGEBOX_SITES_HOST` | sesión de lectura | 12 h sliding |

Ambas **host-only** (nunca `Domain=.adiabox.es`: esa cookie viajaría a `dokploy.`, `db.`,
`garage.`), `HttpOnly`, `Secure`, `SameSite=Lax`.

Flujo para un sitio privado:

```
GET https://pages.adiabox.es/s/docs-a/guia
   ├─ pb_view válida + grant sobre docs-a  → 200
   ├─ pb_view válida sin grant             → 404  (no confirmar que el sitio existe)
   └─ sin pb_view
        ├─ Accept: text/html   → 302 a /login?next=<url>  (login vive en pages., no en pagebox.)
        └─ sub-recurso         → 401 seco
```

**El detalle que rompe implementaciones ingenuas:** si la sesión caduca a media
navegación, un `<script src>` que recibe un 302 a HTML revienta la página en silencio. Por
eso el redirect solo se emite en navegaciones (`Accept: text/html`); todo lo demás, 401.

Login duplicado en `pages.` y en `pagebox.`: sí, dos formularios contra el mismo backend de
usuarios. Es el precio de no compartir origen, y es correcto.

### D5 — Identidad propia, con puerta abierta a OIDC

El requisito es "superadmin crea usuarios". Se resuelve con **better-auth** + su plugin
`admin` (crear/banear/impersonar usuarios) en vez de escribir auth a mano. Deja además el
plugin OIDC listo para, más adelante, delegar en Authentik sin migrar el modelo de datos.

Sin concepto de _organización_ en v1. Grupos + grants sobre sitios cubren el caso del
homelab; añadir orgs después es una tabla más, no una refactorización.

---

## 3. Stack propuesto

| Capa      | Elección                                             | Motivo                                                                                                                                                 |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime   | **Node 22**                                          | Estable, imagen ligera, Dokploy-friendly.                                                                                                              |
| Framework | **SvelteKit** (adapter-node)                         | Panel + API + proxy de assets en **un solo deployable**, sirviendo dos hostnames desde el hook `handle`. El repo ya tiene tooling y skill de Svelte 5. |
| Auth      | **better-auth** (`admin` plugin)                     | Sesiones, hashing, creación de usuarios por admin. No reinventar.                                                                                      |
| DB        | **Postgres** (el compartido de `core`) + **Drizzle** | Migraciones versionadas. `provision-pg.sh pagebox`.                                                                                                    |
| Cache     | **Valkey** (el de `core`)                            | Cache de grants. Opcional en v1.                                                                                                                       |
| Objetos   | **Garage S3**                                        | Ya existe y ya se respalda.                                                                                                                            |
| Unzip     | **`yauzl`** streaming                                | Control explícito sobre cada entrada (§6, zip-slip).                                                                                                   |
| Hash pwd  | argon2id (el de better-auth)                         | —                                                                                                                                                      |

El hook `handle` de SvelteKit despacha por `event.url.host`: si es el host de sitios →
resolver + servir; si es el de admin → rutas normales de la app. Cualquier otro Host →
421/404.

> Alternativa si el hot path de assets se vuelve el cuello de botella: partir en
> `pagebox-admin` (SvelteKit) + `pagebox-edge` (Hono/Go). **No en v1**: optimización sin datos.

---

## 4. Modelo de datos

```
user            (better-auth)  id, email, name, password_hash, role: 'superadmin'|'user', banned, created_at
session         (better-auth)  id, user_id, scope: 'admin'|'view', expires_at, ip, ua
group                          id, slug, name, created_at
group_member                   group_id, user_id                      PK(group_id, user_id)
site                           id, slug UNIQUE, name, visibility: 'public'|'private',
                               base_path,                 -- '/s/<slug>/' en v1
                               hostname NULL UNIQUE,      -- v2, subdominio propio
                               spa_fallback bool, active_deployment_id, owner_user_id,
                               created_at, archived_at
deployment                     id (ULID), site_id, status: 'uploading'|'ready'|'failed',
                               file_count, total_bytes, created_by, created_at, notes,
                               source: 'api'|'panel-upload',
                               warnings jsonb,            -- avisos del preflight (§6.3)
                               acknowledged_at NULL       -- el usuario aceptó desplegar con avisos
site_grant                     id, site_id,
                               principal_type: 'user'|'group', principal_id,
                               role: 'viewer'|'deployer'|'owner'
                               UNIQUE(site_id, principal_type, principal_id)
deploy_token                   id, site_id NULL(=todos), name, token_hash, prefix,
                               created_by, last_used_at, expires_at, revoked_at
audit_log                      id, actor_user_id NULL, actor_token_id NULL, action,
                               target_type, target_id, meta jsonb, ip, created_at
```

**Permisos efectivos** sobre un sitio, para un usuario:

```
superadmin                         → owner
site.owner_user_id == user.id      → owner
max(role) de site_grant donde principal = user, o principal ∈ grupos(user)
site.visibility == 'public'        → viewer (aunque sea anónimo)
```

`viewer` = leer el sitio. `deployer` = viewer + crear deployments + activar/rollback.
`owner` = deployer + gestionar grants, tokens y visibilidad.

---

## 5. Semántica de servido

Petición `GET https://<SITES_HOST>/s/<slug>/<subpath>`. Tras `resolveSite`, resolución de
`<subpath>` dentro del deployment activo, **en este orden**:

1. `subpath` exacto.
2. `subpath + ".html"` — Next/Fumadocs con `trailingSlash: false`.
3. `subpath + "/index.html"` — Docusaurus, Next con `trailingSlash: true`.
4. Si `subpath` acaba en `/` → `subpath + "index.html"`.
5. Si `spa_fallback` → `index.html` con **200**.
6. `404.html` del sitio con status 404; si no existe, 404 propio.

Además:

- **`GET /s/<slug>` sin barra final → 301 a `/s/<slug>/`.** Sin esto, toda ruta relativa
  del HTML resuelve un nivel arriba y el sitio se ve roto. Aplica también dentro (regla 3).
- `Content-Type` por extensión (tabla propia, **no** confiar en el del objeto S3).
- `X-Content-Type-Options: nosniff` siempre.
- Soporte `HEAD` y `Range` (PDFs, vídeo).
- Si existe `<path>.br` / `<path>.gz` y el cliente los acepta → servirlos con
  `Content-Encoding` correcto.
- **Nunca** emitir `Service-Worker-Allowed`. Por defecto el navegador limita el scope de un
  SW al path desde el que se sirve, así que el SW de `/s/site-a/` no puede secuestrar
  `/s/site-b/`. Emitir esa cabecera rompería la única barrera que hay entre sitios.
- **Nunca** servir rutas que empiecen por `.` (`.git`, `.env`) ni `/__pb/*`.
- Cache:
  - HTML → `no-cache` (revalidar siempre; si no, un deploy no se ve).
  - Assets con hash en el nombre → `public, max-age=31536000, immutable`.
  - Sitio privado → **`private, no-store` + `Vary: Cookie` para TODO**, sobrescribiendo lo anterior.
- `_redirects` y `_headers` estilo Netlify: **v2**, no v1.

---

## 6. API de despliegue

Vive en `PAGEBOX_ADMIN_HOST` bajo `/api/v1`.

### 6.1 El CI pregunta su propio slug antes de construir

```http
GET /api/v1/whoami
Authorization: Bearer pbx_<token>

→ 200 {
    "siteId":   "01J...",
    "slug":     "docs-a",
    "basePath": "/s/docs-a/",
    "siteUrl":  "https://pages.adiabox.es/s/docs-a/",
    "mode":     "path"                    // "subdomain" en v2 → basePath "/"
  }
```

Así el build no lleva el prefijo hardcodeado: se inyecta en tiempo de CI. Cuando un sitio
migre a subdominio (v2), el mismo pipeline devuelve `basePath: "/"` y el siguiente build
sale correcto sin tocar el workflow.

### 6.2 Deployments

```http
POST /api/v1/sites/{slug}/deployments
Authorization: Bearer pbx_<token>
Content-Type: application/zip
X-Deployment-Notes: "commit abc1234"

→ 201 { "deploymentId": "01J...", "status": "ready", "fileCount": 812,
        "url": "https://pages.adiabox.es/s/docs-a/" }
```

Sube → extrae en temporal → valida → sube a S3 bajo el nuevo `deploymentId` → **al
terminar todo**, `UPDATE site SET active_deployment_id`. Si algo falla, el activo no se
mueve.

Endpoints mínimos v1: `GET /whoami`, `POST /deployments`, `GET /deployments`,
`POST /deployments/{id}/activate` (rollback), `DELETE /deployments/{id}`.

### 6.3 Subida por arrastrar y soltar (panel)

Objetivo: soltar una **carpeta**, un **`.zip`** o un **`index.html`** suelto sobre el
detalle del sitio en el panel y que quede desplegado. Sin CLI, sin CI, sin token.

#### Un solo camino de ingesta

El navegador **empaqueta en cliente** (`fflate`, modo _store_, sin comprimir) y llama al
**mismo** `POST /api/v1/sites/{slug}/deployments` con `Content-Type: application/zip`. No
se añade un endpoint multipart alternativo: dos caminos de ingesta = dos juegos de guardas
que divergen. Modo _store_ además deja el ratio comprimido:descomprimido en 1:1, así que no
dispara el guard de zip-bomb con builds legítimos.

Diferencia con el camino de CI: aquí la autenticación es la **cookie de sesión del panel**,
no un bearer. Eso lo hace vulnerable a CSRF ⇒ **exige cabecera de CSRF token**; el bearer
está exento.

Entradas y cómo se leen:

| Se suelta        | Lectura                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| Carpeta          | `DataTransferItem.webkitGetAsEntry()` + recorrido recursivo → rutas relativas. |
| `.zip`           | Se sube tal cual, sin reempaquetar.                                            |
| Ficheros sueltos | Se empaquetan en la raíz.                                                      |

Cap propio de navegador (p. ej. 100 MB) por debajo del `MAX_UPLOAD_BYTES` del servidor:
empaquetar en memoria escala mal. Por encima → mensaje que remite al camino de CI.

#### Preflight en cliente, antes de subir nada

Es **UX, no seguridad** — el servidor revalida todo (§6.4) porque el cliente es del
atacante. Pero es lo que convierte el drop en algo usable:

1. **Raíz mal elegida** — el fallo nº1. Si en el nivel superior hay un único directorio y
   no hay `index.html`, es que se ha soltado la carpeta contenedora en vez de su contenido.
   Detectarlo y ofrecer _"usar `dist/` como raíz"_ preseleccionado.
2. **Falta `index.html`** en la raíz elegida → aviso.
3. **Rutas absolutas de raíz** — escanear los `.html` buscando `src="/…"`, `href="/…"`,
   `url(/…)`. Si aparecen, el build **no va a funcionar bajo `/s/<slug>/`**. Es el aviso
   importante, y hay que darlo con el motivo, no con un "puede fallar".
4. **Huella del generador** → mostrar la línea de config exacta que hay que cambiar:

   | Se detecta                                | Aviso                                                      |
   | ----------------------------------------- | ---------------------------------------------------------- |
   | `_next/`                                  | Next/Fumadocs: `basePath: '/s/<slug>'` **y** `assetPrefix` |
   | `.docusaurus/`, meta generator Docusaurus | `baseUrl: '/s/<slug>/'`                                    |
   | `_astro/`                                 | Astro: `base: '/s/<slug>'`                                 |
   | `assets/index-<hash>.js` (Vite)           | `base: '/s/<slug>/'`                                       |
   | Nada reconocible + rutas absolutas        | "usa rutas relativas o reconstruye con base path"          |

5. **Caps** de nº de ficheros y bytes.
6. **Dotfiles / `node_modules/` / `.git/`** en el paquete → aviso y exclusión por defecto.

#### Dónde queda la responsabilidad

Si hay avisos, el botón de desplegar queda detrás de un check explícito:

> ☐ Entiendo que este build puede no funcionar servido bajo `/s/<slug>/` y que la
> configuración del `base path` es responsabilidad mía.

Al aceptar: `deployment.warnings` guarda la lista, `acknowledged_at` la marca de tiempo, y
el `audit_log` registra quién aceptó qué. **La plataforma despliega igualmente** — no
bloquea, no adivina, no reescribe HTML. Cuando después "no funciona", hay traza de qué se
avisó.

El panel enlaza a `/help/deploy`, generada **con el slug real y su `basePath`** ya
sustituidos, para poder copiar y pegar.

#### Verificación posterior (opcional, alto valor)

Tras activar, el servidor pide `/s/<slug>/`, parsea el HTML y hace `HEAD` sobre las
primeras N referencias locales. Si fallan, marca el deployment como _"desplegado con N
assets rotos"_ en la UI. Barato, y convierte el aviso previo en un hecho comprobado.

### 6.4 Guardas obligatorias al extraer el zip

| Riesgo                            | Guarda                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Zip-slip** (`../../etc/passwd`) | Normalizar cada entrada; rechazar si sale del root. `yauzl` no lo hace por ti.                                            |
| **Zip bomb**                      | Límite de tamaño descomprimido total (500 MB) y ratio comprimido:descomprimido (100:1). Abortar al cruzarlo, no al final. |
| Symlinks                          | Rechazar entradas con modo symlink.                                                                                       |
| Nº de ficheros                    | Cap 20 000.                                                                                                               |
| Tamaño del upload                 | Cap en Traefik **y** en la app (200 MB).                                                                                  |

> Si algún build supera el cap, la vía es subida directa a S3 con presigned multipart — el
> repo tiene la skill `s3-direct-upload`. **No en v1.**

Tokens: generar `pbx_<32 bytes base64url>`, guardar solo `sha256`, mostrar una vez. Los
primeros 8 caracteres en claro (`prefix`) para identificarlos en la UI.

### 6.5 Workflow objetivo (sin CLI propia)

```yaml
- id: pb
  run: |
    curl -sfS https://pagebox.adiabox.es/api/v1/whoami \
      -H "Authorization: Bearer ${{ secrets.PAGEBOX_TOKEN }}" \
      | jq -r '"base=" + .basePath' >> $GITHUB_OUTPUT

- run: npm run build
  env:
    # Docusaurus: baseUrl · Next: basePath+assetPrefix · Vite/Astro: base · SvelteKit: paths.base
    SITE_BASE_PATH: ${{ steps.pb.outputs.base }}

- run: (cd dist && zip -qr ../site.zip .)
- run: |
    curl -sfS -X POST https://pagebox.adiabox.es/api/v1/sites/docs-a/deployments \
      -H "Authorization: Bearer ${{ secrets.PAGEBOX_TOKEN }}" \
      -H "Content-Type: application/zip" \
      --data-binary @site.zip
```

Soporte de `basePath` por generador: Next/Fumadocs `basePath`+`assetPrefix`, Docusaurus
`baseUrl`, Astro/Vite `base`, SvelteKit `paths.base`, MkDocs `site_url`. Todos ok.

---

## 7. Superficie de UI

### Panel — `PAGEBOX_ADMIN_HOST` (default `pagebox.adiabox.es`)

- **Login** + (v2) TOTP.
- **Sites**: lista, crear (slug + visibilidad), detalle → deployments (activar/rollback),
  grants (usuario/grupo + rol), tokens, borrar. Muestra siempre la **URL pública y el
  `basePath`** del sitio, para copiar al CI.
- **Dropzone** en el detalle del sitio (§6.3): carpeta / `.zip` / `index.html` suelto,
  preflight con avisos y check de responsabilidad antes de desplegar.
- **`/help/deploy`**: instrucciones de `base path` por generador, con el slug y el
  `basePath` del sitio ya sustituidos. Enlazada desde el dropzone y desde el detalle.
- **Users** (solo superadmin): crear (email + password temporal), banear, cambiar rol
  global, resetear password.
- **Groups**: crear, añadir/quitar miembros.
- **Audit log**: filtrable por actor / acción / sitio.
- **Mis sitios**: vista de usuario normal.

### Host de sitios — `PAGEBOX_SITES_HOST` (default `pages.adiabox.es`)

Superficie **mínima a propósito** — cuanto menos código propio corra en ese origen, menos
puede tocar un build alojado:

- `GET /login` + `POST /login` (sesión `pb_view`), `POST /logout`.
- `GET /healthz`.
- `GET /` → landing mínima o 404. **No** listar sitios (filtra existencia de privados).
- Todo lo demás bajo `/s/<slug>/…`.

**No** exponer ningún endpoint de administración en este host.

---

## 8. Milestones

| M      | Entrega                                                    | Criterio de aceptación                                                                                                                                                                                                                                                                                                                                  |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0** | Scaffold + Docker + esquema + migraciones + split de hosts | `docker compose up`; la app arranca con dos hosts y **falla al arrancar** si coinciden.                                                                                                                                                                                                                                                                 |
| **M1** | `resolveSite` + servir desde S3                            | Un `deploymentId` puesto a mano se sirve en `/s/<slug>/`; las 6 reglas de §5 y el 301 de barra final, cubiertos por test.                                                                                                                                                                                                                               |
| **M2** | API (`whoami` + deployments) + zip                         | Un build real de Docusaurus y otro de Fumadocs export, construidos con el `basePath` que devuelve `whoami`, navegables sin un solo 404 de asset. Tests de zip-slip y zip-bomb en verde.                                                                                                                                                                 |
| **M3** | Auth + panel (users, groups, sites)                        | Superadmin crea usuario; el usuario entra y solo ve sus sitios.                                                                                                                                                                                                                                                                                         |
| **M4** | Sitios privados + grants                                   | Anónimo → login. Con sesión y sin grant → 404. Con grant → sitio **y todos sus assets**. Test: un sitio privado nunca emite cabecera cacheable, ni en HTML ni en `.js`. Test: sub-recurso sin sesión → 401, no 302.                                                                                                                                     |
| **M5** | Deploy tokens, rollback, audit log                         | GH Actions despliega end-to-end; rollback en 1 clic.                                                                                                                                                                                                                                                                                                    |
| **M6** | Drag & drop en el panel (§6.3)                             | Soltar una carpeta `dist/`, un `.zip` y un `index.html` suelto → sitio en marcha. Soltar la carpeta _contenedora_ por error → el preflight lo detecta y propone la raíz correcta. Un build con rutas absolutas → aviso con la línea de config del generador, check de responsabilidad, y despliegue si se acepta. CSRF exigido en la subida por cookie. |
| **M7** | Despliegue en el homelab                                   | Dos dominios en Dokploy, 3 sitios reales en marcha.                                                                                                                                                                                                                                                                                                     |

**Fuera de v1, en orden de valor**: subdominio por sitio (§12) · deploy previews por rama ·
`_redirects`/`_headers` · basic-auth por sitio (compartir sin crear usuario) · OIDC contra
Authentik · cuotas por sitio · webhooks.

---

## 9. Despliegue en este homelab (M7)

Siguiendo `services/_conventions.md` y `PROVISIONING.md`:

- Proyecto Dokploy propio: **`app-pagebox`** (es una app, no un recurso compartido → no va
  en `core`).
- Tipo **Application** (Dockerfile) → los dos hostnames se dan de alta con **Add Domain**,
  sin ficheros dinámicos de Traefik. (Si acabara siendo Compose, recordar el gotcha: los
  Compose **no** rutean por labels ni por Add Domain, hace falta `.yml` dinámico a mano.)
- Postgres: `bash /scripts/provision-pg.sh pagebox` en `core-dbadmin` → `DATABASE_URL`.
- Garage: bucket `pagebox` + key con permisos solo sobre ese bucket
  (`PROVISIONING.md §S3`). Endpoint `http://192.168.1.197:3900`, `forcePathStyle: true`.
- Valkey: opcional; si se usan colas, cuidado con la **ACL de BullMQ** (hay que ampliar a
  `~bull:<prefix>-*`; el `provision-valkey.sh` pelado no basta).
- Cloudflare: **nada**. Los dos hostnames caen bajo el wildcard existente.
- **CF Access:** tentador ponerlo delante de `pagebox.` siguiendo el patrón de
  `dokploy.`/`db.`/`garage.`. Si se hace, **el CI deja de poder llamar al API** salvo que
  se añada una policy de bypass para `/api/v1/*` o se usen service tokens
  (`CF-Access-Client-Id/Secret`) en el workflow. El drag & drop del panel no se ve afectado
  (va por navegador, con la sesión de CF Access ya puesta). Nunca CF Access delante de
  `pages.`: los sitios públicos dejarían de ser públicos.

### Variables de entorno

```bash
# hostnames — DEBEN ser distintos, la app no arranca si coinciden
PAGEBOX_ADMIN_HOST=pagebox.adiabox.es      # panel + API
PAGEBOX_SITES_HOST=pages.adiabox.es        # sitios desplegados
PAGEBOX_SITES_PREFIX=/s                    # prefijo de path de los sitios
PAGEBOX_PUBLIC_SCHEME=https                # para construir URLs absolutas tras el túnel

DATABASE_URL=...
REDIS_URL=...
S3_ENDPOINT=http://192.168.1.197:3900
S3_ACCESS_KEY=... S3_SECRET_KEY=... S3_BUCKET=pagebox S3_FORCE_PATH_STYLE=true

AUTH_SECRET=...                            # firma de sesiones
BOOTSTRAP_ADMIN_EMAIL=...                  # solo primer arranque
BOOTSTRAP_ADMIN_PASSWORD=...               # forzar cambio en el primer login

MAX_UPLOAD_BYTES=209715200
MAX_UNCOMPRESSED_BYTES=524288000
MAX_FILES=20000

# v2 (§12), sin efecto en v1
PAGEBOX_BASE_DOMAIN=
PAGEBOX_SUBDOMAIN_MODE=false
```

Detrás del túnel la app recibe HTTP; las URLs absolutas se construyen con
`PAGEBOX_PUBLIC_SCHEME` + el host de config, **nunca** con `X-Forwarded-Proto` a ciegas.

---

## 10. Checklist de seguridad (revisar antes de exponer)

- [ ] `PAGEBOX_ADMIN_HOST != PAGEBOX_SITES_HOST` verificado **en el arranque**, no en un test.
- [ ] Ningún endpoint de admin/API alcanzable desde el host de sitios.
- [ ] Cookies `pb_admin` y `pb_view` **host-only**, nunca `Domain=.adiabox.es`.
- [ ] Sitio privado: **ningún** response cacheable (`curl -I` sobre HTML y sobre un `.js`).
- [ ] Sitio privado inexistente vs sin permiso → misma respuesta (404).
- [ ] Sub-recurso sin sesión → 401, nunca 302 a HTML.
- [ ] Nunca emitir `Service-Worker-Allowed`.
- [ ] Zip-slip, zip-bomb, symlinks, cap de ficheros y de bytes — **revalidados en servidor**
      aunque el preflight del navegador ya los haya comprobado.
- [ ] Subida por cookie de sesión (drag & drop) exige **CSRF token**; el camino bearer no.
- [ ] Rate limit en `/login` de ambos hosts.
- [ ] Tokens de deploy solo hasheados; revocables; `last_used_at` visible.
- [ ] CSRF en todas las mutaciones del panel.
- [ ] Slug validado con `^[a-z0-9][a-z0-9-]{1,40}$`.
- [ ] Nunca servir dotfiles ni `/__pb/*` desde el bucket.
- [ ] Documentado al usuario: **los sitios comparten origen entre sí**; no alojar builds
      que no controlas hasta v2.
- [ ] Bucket `pagebox` incluido en la política de respaldo de Garage (`SECURITY-TODO.md` —
      el offsite sigue siendo el hueco grande).

---

## 11. Preguntas abiertas para la sesión de implementación

1. ¿Cuántos usuarios reales? Si son <10 y de confianza, M3/M4 se pueden simplificar.
2. ¿Tamaño máximo realista de un build? Si algo pasa de 200 MB, sube la prioridad de la
   subida directa a S3.
3. ¿Repo propio para PageBox, o dentro de este? Recomendación: **repo propio**; este repo
   se queda con la guía de despliegue en `services/pagebox.md`.
4. ¿CF Access delante del panel, con service tokens en el CI? Decide antes de M7.
5. ¿Cap de subida por navegador? 100 MB es un punto de partida razonable; por encima, el
   empaquetado en memoria del cliente empieza a doler y conviene remitir al camino de CI.

---

## 12. v2 — subdominio por sitio (diferido, no olvidado)

**Disparadores para hacerlo**, cualquiera de ellos:

- Hay que alojar un build que **no controlas** (el aislamiento por origen deja de ser opcional).
- Un sitio necesita **dominio propio** (`docs.cliente.com`).
- El acoplamiento build↔slug se vuelve molesto en la práctica.

**Qué hay que verificar primero (30 s en el dashboard de Cloudflare):** si existe el CNAME
wildcard `*.adiabox.es → <tunnel-id>.cfargotunnel.com` proxied, o solo la regla de ingress
del túnel. **Si no existe el DNS wildcard, v2 exige un registro por sitio** — y entonces el
modo path probablemente sea la versión definitiva, no una v1.

**Qué cambia:**

1. Router catch-all en Traefik, fichero dinámico a mano:
   ```yaml
   http:
     routers:
       pagebox-catchall:
         rule: "HostRegexp(`^[a-z0-9][a-z0-9-]*\\.adiabox\\.es$`)" # Traefik v3: regexp Go, con ^ y $
         priority: 1 # mínima: cualquier Host(...) específico gana
         service: pagebox
         entryPoints: [web]
   ```
2. Rama nueva en `resolveSite` (host → `site.hostname`), `base_path` pasa a `/`.
3. Lista de slugs reservados: `dokploy, db, garage, draw, blog, docs, s3, mc, www, api,
auth, admin, pages, pagebox`.
4. **Vuelve el flujo SSO por redirect** que el modo path nos ahorra: cada subdominio es un
   origen distinto, así que `pb_view` deja de servir para todos. Diseño:
   `<slug>.adiabox.es` sin cookie → 302 a `pages.adiabox.es/authorize?site=…` → si hay
   sesión y grant, 302 de vuelta a `<slug>.adiabox.es/__pb/cb?t=<JWT 30 s, aud=siteId, un
solo uso vía nonce en Valkey>` → set cookie host-only → 302 al destino. Con la misma
   regla de `Accept: text/html` para no romper sub-recursos.
5. Migración por sitio: `whoami` devuelve `basePath: "/"`, se relanza el build, se apunta
   `site.hostname`. Coexistencia posible — unos sitios en path, otros en subdominio.
6. Dominios propios de terceros: **fuera del wildcard de Universal SSL**. Requeriría que
   Traefik emita certificados, lo que contradice ADR-0001 ("sin Let's Encrypt en Dokploy").
   Decisión aparte, no automática con v2.
