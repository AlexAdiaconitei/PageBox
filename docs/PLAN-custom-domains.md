# Plan para dominios personalizados y sites en raíz

Fecha de revisión: 2026-10-05.

Este documento detalla la implementación propuesta a partir del código actual, incluidos los cambios locales del checkout. La investigación de infraestructura y sus fuentes están en [custom-domains-research.md](custom-domains-research.md).

## Resultado esperado

Un site nuevo debe poder publicar un build preparado para `/` y abrirse en `https://docs.cliente.com/`. Sus assets deben funcionar como `/assets/app.js`, `/_next/static/...` o `/favicon.ico`, sin añadir `/s/<slug>/`.

Propongo conservar el subdominio que PageBox genera con el ID inmutable como dirección de respaldo. También servirá desde `/`. Así, retirar un dominio personalizado no obliga a cambiar el build ni deja al site sin dirección.

| Uso | Dirección de ejemplo |
| --- | --- |
| Panel y API | `https://pagebox.example.com/` |
| Login central de lectores | `https://pages.example.com/login` |
| Dirección propia de PageBox | `https://docs-<site-id>.pages.example.com/` |
| Dominio personalizado | `https://docs.cliente.com/` |

El alcance inicial será un dominio personalizado por site, tanto público como privado. El hostname exacto identifica al site. El slug continúa identificándolo en el panel y en la API, pero deja de formar parte de la ruta pública de los sites nuevos.

Los sites existentes seguirán con su prefijo hasta que su propietario migre el build. El objetivo es dejar de necesitar el modo basepath; conservar temporalmente las rutas antiguas evita romper los deployments que ya existen.

## Lo que hace el código actual

| Archivo | Comportamiento comprobado | Cambio necesario |
| --- | --- | --- |
| [config.ts](../src/lib/server/config.ts) | `hostKind` acepta el panel, el lector central y subdominios con ID. `siteUrl` siempre usa el subdominio generado y `site.basePath`. | Separar la clasificación de hosts centrales de la resolución de hosts de contenido. Construir direcciones desde configuración y registros validados. |
| [resolve.ts](../src/lib/server/sites/resolve.ts) | `resolveSite` exige `/s/<slug>/`, incluso en el subdominio propio. Comprueba que el ID y el hostname generado coincidan. | Resolver dominios exactos y paths desde `/`; conservar la rama antigua durante la migración. |
| [sites.ts](../src/lib/server/db/schema/sites.ts) | `site` ya tiene `basePath` y `hostname`, con índice único. `hostname` no participa en el resolver. | Añadir el estado operativo de dominios y la compatibilidad de cada deployment con su ruta pública. |
| [hooks.server.ts](../src/hooks.server.ts) | Rechaza hosts desconocidos antes de resolver sites. El lector central redirige el contenido a su subdominio. Solo esos subdominios llegan a `acceptReader`. | Clasificar dominios registrados antes del rechazo y mantener el lector central libre de contenido subido. |
| [serve.ts](../src/lib/server/sites/serve.ts) | Sirve desde S3 a partir de `siteRef` y `subpath`, con autorización por archivo. | Reutilizarlo. El dominio no debe cambiar las claves S3 ni el control de acceso. |
| [reader.ts](../src/lib/server/auth/reader.ts) | El login central emite códigos de 30 segundos, de un solo uso, y crea una cookie host-only de site. Comprueba el origen completo contra `siteUrl`. | Vincular código y sesión al origen concreto de destino, también cuando un site tenga dos direcciones. |
| [destinations.ts](../src/lib/server/auth/destinations.ts) | Valida `next` dentro de `basePath` y rechaza traversal y rutas reservadas. | Cubrir `basePath: '/'` y el destino de dominio seleccionado. |
| [whoami](../src/routes/api/v1/whoami/+server.ts) | Devuelve `basePath`, `siteUrl` y `mode: 'subdomain'`, aunque el site siga bajo `/s/<slug>/`. | Distinguir modo de ruta y tipo de hostname. Exponer el destino de un build de migración. |
| [ingest.ts](../src/lib/server/deploy/ingest.ts) | Reutiliza archivos por checksum e ingest version. `activate` cambia el deployment activo bajo el lock de almacenamiento. | Incorporar la ruta para la que se construyó el archivo y coordinar su activación con el cambio a raíz. |
| [preflight.ts](../src/lib/preflight.ts), [Dropzone.svelte](../src/lib/components/Dropzone.svelte) y [verify.ts](../src/lib/server/deploy/verify.ts) | Recetas, avisos y comprobación de assets dependen de `basePath`. | Ajustar recetas para raíz y detectar prefijos antiguos que seguirían rompiendo un build. |
| [perms.ts](../src/lib/server/perms.ts) y páginas de sites | Los resúmenes incluyen `basePath`, pero no el estado del dominio. | Cargar la dirección personalizada mediante consultas por lote, sin una consulta por cada site. |
| [docker-compose.yml](../docker-compose.yml), [docker-compose.dokploy.yml](../docker-compose.dokploy.yml) y [router de ejemplo](../deploy/traefik-dynamic.example.yml) | El routing cubre hosts centrales y subdominios generados. El perfil standalone solo expone HTTP. | Añadir rutas exactas para dominios personalizados y una configuración de TLS operativa. |

La separación de orígenes y el intercambio de lector ya existen. No hace falta volver a diseñar la autenticación desde cero. Sí hace falta retirar la suposición de que un site solo tiene un origen de contenido.

Hay documentación antigua que ya no describe el checkout. [base-paths.md](base-paths.md) afirma que los sites siempre se sirven bajo `/s/<slug>/` y [PLAN-static-hosting.md](PLAN-static-hosting.md) aplaza el aislamiento por subdominio. El código actual ya aplica ese aislamiento. Ese brief también cita una ADR que prohíbe Let's Encrypt en Dokploy; no he localizado el archivo de esa ADR en este repositorio. La implementación debe registrar la decisión de TLS real de la instalación, en vez de asumir que el brief describe el entorno activo.

## Decisiones propuestas

1. Crear sites nuevos con `basePath: '/'` y mantener su subdominio con ID inmutable.
2. Admitir un hostname personalizado exacto por site. `www.cliente.com` y `cliente.com` son dos hostnames distintos; los aliases adicionales quedan para una ampliación posterior.
3. Usar una tabla `site_domain` para verificación, routing y TLS. Una columna `hostname` sola no distingue un dominio solicitado de uno que ya puede recibir tráfico.
4. Verificar control del hostname con un TXT ligado al site y al registro de dominio. Apuntar un CNAME a PageBox no concede propiedad dentro de la aplicación.
5. Mantener login y credenciales de lector en `PAGEBOX_SITES_HOST`. Un dominio personalizado aloja contenido y el callback reservado, no formularios de login de PageBox.
6. Servir el mismo build en raíz por el dominio personalizado y por el subdominio de respaldo. La primera versión no redirigirá automáticamente este último al personalizado.
7. Recomendar Traefik con reglas `Host(...)` exactas y certificados por dominio cuando exista una entrada pública. Mantener un modo de provisión manual para instalaciones cuyo proxy administra el operador.
8. Tratar Cloudflare Tunnel como una topología distinta. Los dominios externos necesitan una solución de TLS y routing en el edge, por ejemplo Cloudflare for SaaS, o una entrada pública alternativa.

Cambiar de dominio puede exigir reconstruir canonical URLs, sitemaps, Open Graph o el `baseURL` de Hugo. Eliminar el prefijo quita el acoplamiento de las rutas al slug; no elimina las URLs absolutas que un generador haya escrito dentro del build.

## DNS, proxy y HTTPS

### Instalación con entrada pública a Traefik

El operador configura un destino estable, por ejemplo `sites-edge.example.com`, que apunta al proxy. Para un subdominio, el panel muestra estos registros:

```text
docs.cliente.com                  CNAME  sites-edge.example.com
_pagebox-verify.docs.cliente.com   TXT    pagebox-verification=<token>
```

Para un dominio apex, el panel debe mostrar las IP públicas A y AAAA autorizadas por el operador. ALIAS, ANAME o flattening dependen del proveedor DNS y se documentarán como alternativas. No se debe prometer un CNAME ordinario en el apex.

El CNAME solo resuelve la dirección de red. La petición conserva `Host: docs.cliente.com` y el handshake TLS usa ese nombre. Traefik necesita una ruta para ese host y un certificado que lo cubra. La documentación de [ACME en Traefik](https://doc.traefik.io/traefik/v3.3/https/acme/) describe la emisión y los challenges.

Separar certificados de la plataforma y de clientes:

- El panel y el lector central necesitan sus certificados.
- `*.pages.example.com` necesita un certificado wildcard o certificados individuales para los subdominios generados. ACME wildcard requiere DNS-01.
- `docs.cliente.com` necesita un certificado para ese hostname. HTTP-01 permite emitirlo sin pedir al cliente credenciales de su proveedor DNS, si el puerto 80 llega al proxy correcto.

El wildcard `*.pages.example.com` no cubre `pages.example.com`. Tampoco el certificado de `*.example.com` cubre `docs-<id>.pages.example.com`. Esta diferencia afecta especialmente a instalaciones con Universal SSL de Cloudflare; véase la [cobertura oficial](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

El challenge HTTP-01 lo atiende Traefik antes de PageBox. No se cambia la prohibición de dotfiles en los deployments ni se permite que un archivo subido responda a `/.well-known/acme-challenge/`.

Ejemplo de configuración dinámica propuesta, con nombres que el operador debe sustituir:

```yaml
http:
  routers:
    pagebox-custom-<domain-id>:
      rule: 'Host(`docs.cliente.com`)'
      entryPoints: [websecure]
      service: pagebox-content
      tls:
        certResolver: pagebox-custom
  services:
    pagebox-content:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: 'http://pagebox:3000'
```

Esto no configura el resolver ACME, el entrypoint HTTP del challenge, el almacenamiento persistente de certificados ni los puertos públicos. Esos elementos se añaden a la configuración estática del proxy. El backend es fijo y lo define el operador; un propietario de site nunca puede introducir una URL de backend.

### Dokploy

La aplicación puede seguir siendo un único servicio en el puerto 3000. No hace falta crear una aplicación Dokploy por site.

La documentación local afirma que Compose ignora "Add Domain". La [documentación actual de Dokploy](https://docs.dokploy.com/docs/core/domains) contempla dominios para Compose, cuya configuración se aplica mediante labels y requiere redeploy. En Application, Dokploy administra archivos dinámicos. Hay que comprobar la versión instalada antes de elegir la integración.

Para dominios frecuentes, propongo un archivo dinámico propio de PageBox y un servicio de contenido con nombre propio. El reconciliador no modificará los archivos que genera Dokploy. El operador debe verificar que el provider file lee ese directorio y que el backend pertenece a la red de Traefik. Si no quiere conceder acceso al directorio, puede añadir cada dominio en Dokploy y usar la comprobación de disponibilidad de PageBox.

### Cloudflare Tunnel

No hay evidencia de la configuración activa del homelab. El repositorio menciona un túnel, pero eso no confirma DNS, cuenta de Cloudflare, certificados ni reglas actuales.

Un hostname publicado de una zona controlada por la misma cuenta puede llegar al túnel. Un dominio de cliente fuera de esa cuenta no queda habilitado por apuntarlo al nombre `cfargotunnel.com`. Cloudflare limita esa ruta DNS a la cuenta del túnel. Véase [DNS de Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/).

Si la instalación debe seguir sin puertos públicos y aceptar dominios de otras cuentas, habrá que añadir Cloudflare for SaaS y sus custom hostnames. Cloudflare documenta [Tunnel como origen de SaaS](https://developers.cloudflare.com/reference-architecture/design-guides/extending-cloudflares-benefits-to-saas-providers-end-customers/). Antes de adoptarlo hay que verificar disponibilidad en la cuenta, coste, validación de certificados y preservación del Host hasta PageBox.

Un certificado emitido por Traefik en el origen no resuelve un handshake que Cloudflare rechaza en el edge. El provider SaaS queda como implementación alternativa; el modelo de dominios y la autorización por archivo deben ser iguales.

## Modelo de datos

Usar las convenciones actuales de ULIDs, campos TypeScript en camelCase y columnas SQL en snake_case. Mantener la línea Drizzle 0.45.x del proyecto, sin introducir las APIs de relaciones de v1. Las restricciones se expresarán en PostgreSQL, siguiendo [índices y constraints de Drizzle](https://orm.drizzle.team/docs/indexes-constraints).

### `site_domain`

| Campo | Uso |
| --- | --- |
| `id` | ULID del registro y del nombre de router. |
| `site_id` | FK al site, nullable cuando su borrado deje una reserva histórica del hostname. |
| `bound_site_id` | ID inmutable del site al que se asignó el hostname. Se conserva tras borrar el site. |
| `hostname` | Nombre ASCII normalizado, con índice único global. |
| `status` | `pending_verification`, `verified`, `provisioning`, `active`, `error`, `suspended`, `removing` o `removed`. |
| `verification_token` | Token aleatorio del TXT, ligado al registro. Es una prueba publicada en DNS, no una credencial de sesión. |
| `verified_at`, `last_dns_check_at` | Última prueba válida y último intento de comprobación. |
| `dns_status`, `routing_status`, `tls_status` | Resultados independientes. Un timeout DNS no significa pérdida de propiedad. |
| `provider` | `manual` o `traefik-file` en la primera entrega. |
| `binding_version` | Contador que invalida códigos y sesiones cuando cambia la asociación o su estado de acceso. |
| `desired_revision`, `applied_revision` | Versiones del estado que el worker debe aplicar y del que ha comprobado. |
| `last_error_code`, `last_error_at`, `next_retry_at` | Diagnóstico y reintentos, sin devolver excepciones internas al navegador. |
| `created_at`, `updated_at`, `activated_at`, `removed_at` | Trazabilidad del ciclo de vida. |

Añadir un índice único parcial sobre `site_id` para registros distintos de `removed`. Esto limita la primera versión a un dominio en gestión por site, incluyendo solicitudes pendientes. Un hostname usado para servir contenido conserva su reserva después de retirarse. Una solicitud que nunca llegó a servir puede liberarse al caducar, con un nuevo token en el siguiente intento.

Aplicar checks a estados y revisar las relaciones de borrado. No usar `ON DELETE CASCADE` para destruir la reserva histórica. El borrado de un site deja `site_id` a null, conserva `bound_site_id` y marca el dominio para retirar la ruta. Recuperar un dominio retirado para el mismo site reutiliza el registro, genera un token nuevo e incrementa la versión. La tabla no guarda claves privadas de certificados.

`site.hostname` ya existe. Primero inventariar sus valores. Si están vacíos, conservar la columna sin usar durante una versión y retirarla después. Si hay datos, importarlos como pendientes de verificación. `site_domain` será la única fuente de verdad del dominio personalizado; no mantener dos columnas actualizables con el mismo significado.

### Site y deployment

- Conservar `site.basePath` como ruta efectiva del deployment activo. `/` representa el modo nuevo.
- Añadir `site.routingRevision` para controlar cambios concurrentes de modo y destino de build.
- Añadir `site.pendingRootMigration` para anunciar un build a raíz sin cambiar lo que ya se sirve.
- Añadir `deployment.buildBasePath` y `deployment.targetRoutingRevision`. Identifican el contrato declarado al subir el build.
- Para deployments antiguos, rellenar `buildBasePath` con el `basePath` de su site en el momento de la migración de esquema. Es una declaración de compatibilidad basada en el estado existente, no una comprobación completa del HTML.
- Incluir `buildBasePath` en la reutilización por checksum. Un archivo no puede reutilizar una etiqueta de compatibilidad distinta solo porque sus bytes coincidan.
- Impedir que la activación normal publique un deployment con `buildBasePath` distinto del modo actual. El cambio de modo usa una operación específica y transaccional.

Los objetos continúan bajo `sites/<site-id>/<deployment-id>/...`. Ni el hostname ni el path público forman parte de la clave S3.

### Autorizaciones y sesiones de lector

Añadir `targetOrigin`, `domainId` nullable y `bindingVersion` a `site_authorization` y `site_session`. El origen generado usa su identidad inmutable y el dominio personalizado usa la versión del registro.

Cambiar la unicidad de `site_session` para permitir una sesión por `session_id`, `site_id` y `target_origin`. El canje en el dominio personalizado no debe invalidar la cookie del subdominio de respaldo. Las sesiones antiguas se pueden revocar en la migración; la siguiente visita repite el intercambio central sin cambiar la contraseña.

## Contratos y módulos

El resolver debe devolver la dirección de esta petición junto al site. `siteUrl` deja de ser suficiente para decidir dónde canjear un código cuando existen dos orígenes válidos.

```ts
type ContentAddress = {
  origin: string;
  basePath: string;
  kind: 'generated' | 'custom';
  domainId: string | null;
  bindingVersion: number;
};

type RequestTarget =
  | { kind: 'admin' }
  | { kind: 'reader' }
  | { kind: 'content'; siteRef: SiteRef; address: ContentAddress }
  | { kind: 'unknown' };

type ResolvedSite = {
  siteRef: SiteRef;
  address: ContentAddress;
  subpath: string;
  needsTrailingSlashRedirect: boolean;
};

resolveRequestTarget(host: string): Promise<RequestTarget>;
resolveContentPath(target: RequestTarget, pathname: string): ResolvedSite | null;
canonicalSiteUrl(site: SiteRef, activeDomain: SiteDomain | null): string;
authorizeReader(event: RequestEvent): Promise<Response>;
acceptReader(event: RequestEvent, target: ResolvedContentTarget): Promise<Response>;
loadSiteSession(event: RequestEvent, target: ResolvedContentTarget): Promise<SessionUser | null>;
requestDomain(siteId: string, hostname: string, actor: SessionUser): Promise<DomainSummary>;
verifyDomain(domainId: string, actor: SessionUser): Promise<DomainSummary>;
reconcileDomains(): Promise<ReconciliationResult>;
commitRootMigration(siteId: string, deploymentId: string, expectedRevision: number): Promise<void>;
```

Estas firmas son un contrato propuesto, no código compilable. `ResolvedContentTarget` agrupa `siteRef` y `address`; el callback no necesita un subpath de archivo. Las funciones públicas del servicio de dominios comprueban permisos y hacen sus cambios con auditoría en la misma transacción.

| Módulo propuesto | Responsabilidad |
| --- | --- |
| `src/lib/server/sites/addresses.ts` | Hosts centrales, origen generado, dirección canónica y normalización del Host público. |
| `src/lib/server/domains/hostname.ts` | Normalizar la entrada de dominios y rechazar nombres reservados. |
| `src/lib/server/domains/service.ts` | Alta, verificación, activación, suspensión y retirada con permisos. |
| `src/lib/server/domains/dns.ts` | TXT, CNAME y A/AAAA, con timeout y resultados explícitos. |
| `src/lib/server/domains/providers/traefik.ts` | Renderizar el conjunto de routers deseado y comprobar routing/TLS. |
| `src/lib/server/domains/providers/manual.ts` | Emitir instrucciones y comprobar una ruta configurada por el operador. |
| `src/lib/server/domains/reconcile.ts` | Recuperar operaciones interrumpidas y aplicar revisiones pendientes. |
| `scripts/domains-worker.mjs` | Entrada del proceso worker que consume el servicio de reconciliación compilado. |
| `src/lib/server/sites/resolve.ts` | Traducir host y ruta en el mismo contrato que consume `serveSite`. |
| `src/lib/server/deploy/routing.ts` | Preparar y confirmar migraciones de path a raíz. |

No pasar flags de provider por `serveSite`. El servidor de archivos solo necesita el site autorizado y el path interno.

## Resolución de hosts y paths

Orden del hook propuesto:

1. Reconocer el panel por hostname exacto configurado. Solo aquí se resuelven sus páginas y API.
2. Reconocer el lector central por hostname exacto. Solo aquí se resuelven login, logout y `/access`.
3. Reconocer un subdominio generado, buscar el site por ID y comparar el hostname completo. No aceptar un prefijo arbitrario por tener un ID válido.
4. Buscar un dominio personalizado exacto y activo. Comprobar además que el site existe y no está en borrado.
5. Atender el callback reservado de ese origen antes de resolver archivos.
6. Resolver el contenido desde su `basePath` y delegar en `serveSite`.
7. Responder el mismo 404 de siempre para cualquier host o site que no corresponda.

`/healthz` continúa disponible para probes internos en host desconocido. En un host de contenido a raíz, `/healthz`, `/login`, `/logout`, `/access` o `/api/...` son paths del build si existen, nunca rutas de control de PageBox. Reservar `__pb` y todo `__pb/*`, incluyendo la forma codificada que rechaza el validador de paths.

Para `basePath: '/'`, quitar un único slash inicial y producir `subpath: ''` en `/`. Reutilizar `decodeSubpath`, `normaliseSubpath`, las reglas de extensión, SPA fallback y `404.html`. No insertar el prefijo antiguo dentro de la clave S3.

El lector central conserva `/s/<slug>/...` como entrada de compatibilidad. Para un site migrado, quitar ese prefijo y enviar al destino configurado. El host generado antiguo hará lo mismo para los enlaces históricos de ese mismo site. Un path que realmente pertenezca al build tiene prioridad sobre esta compatibilidad; documentar y probar la colisión con un build que incluya `s/<slug>/`.

Para un site privado, comprobar autorización antes de redirigir un enlace antiguo. Una navegación anónima inicia el login central. Un subrecurso anónimo responde 401 sin `Location`. Un usuario sin grant recibe 404. No introducir un redirect público que revele la URL de un dominio privado.

Consultar dominios en PostgreSQL sin caché de autorizaciones en la primera versión. El lookup indexado por hostname ocurre por petición y mantiene inmediata la retirada. El archivo [cache/index.ts](../src/lib/server/cache/index.ts) contiene claves de metadata, pero `lookupSiteBySlug` y `loadSiteSession` actuales leen la base de datos directamente. No asumir que una invalidación de esa caché revoca dominios o sesiones.

## Login de sites privados

Flujo para una navegación a `https://docs.cliente.com/guia?q=1`:

1. PageBox resuelve el dominio activo y comprueba la sesión específica de ese origen.
2. Si falta, redirige a `pages.example.com/access` con el site, el identificador de dirección y el path relativo de regreso. El servidor valida esa dirección contra el registro, no acepta una URL externa libre.
3. El lector central carga o solicita su sesión, comprueba el grant y crea un código de un solo uso con `siteId`, `targetOrigin`, `domainId`, `bindingVersion`, `nextPath` y expiración de 30 segundos.
4. Redirige al `/__pb/accept` de ese origen exacto.
5. El callback comprueba origen completo, estado y versión de dominio, sesión padre y permiso actual. Consume el código dentro de la transacción, con la protección de concurrencia actual.
6. Emite `__Host-pb_site` con `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` y sin `Domain`. Redirige a `/guia?q=1` y elimina el código de la URL visible.
7. Cada HTML y asset vuelve a comprobar la sesión padre y el grant. Logout central, reset de contraseña y revocación siguen impidiendo las lecturas siguientes.

No añadir los dominios de contenido a `trustedOrigins` de Better Auth ni habilitar cookies cross-subdomain. Las instancias de auth siguen perteneciendo al panel y al lector central. La [documentación de seguridad de Better Auth](https://better-auth.com/docs/reference/security) explica la validación de origen; aquí no hay un motivo para ampliar los orígenes que pueden usar esas credenciales.

Los callbacks y respuestas privadas conservarán `private, no-store`, los headers de CDN, `Vary: Cookie` y `Referrer-Policy: no-referrer`. El proxy no registrará el parámetro `code` en logs de acceso ni lo incluirá en métricas.

Al retirar o suspender un dominio, incrementar `bindingVersion` y revocar sus códigos y sesiones. No basta con quitar su router: una petición que alcance el backend debe fallar también.

## Alta y ciclo de vida de dominios

### Validación de entrada

Normalizar a minúsculas y ASCII mediante `domainToASCII`, disponible en Node 22. Quitar un punto DNS final si existe. Validar de nuevo el resultado y mostrar también el nombre normalizado que se va a registrar. [Node documenta esta conversión](https://nodejs.org/docs/latest-v22.x/api/url.html#urldomaintoasciidomain).

Rechazar URLs, esquema, path, query, credenciales, puertos, wildcard, IPs, `localhost`, nombres internos y labels DNS inválidos. Los dominios de producción no admiten puertos. El modo de pruebas utiliza una configuración separada y direcciones locales explícitas.

Rechazar hosts centrales, el namespace de subdominios generados y los nombres de infraestructura que reserve el operador. No reservar todo `example.com` si la instalación quiere usar otros subdominios propios. Validar el nombre antes de construir una regla Traefik para impedir que la entrada introduzca sintaxis de reglas.

### Verificación DNS

El propietario solicita el dominio. El backend comprueba `owner`, la política de dominios de la instancia y la unicidad en la base de datos. Genera un token aleatorio de 32 bytes y muestra TXT y destino DNS. Un conflicto devuelve un error genérico, sin identificar al otro propietario.

La comprobación TXT compara el valor completo contra el token del registro. El token no se comparte entre sites. Tratar por separado el control del dominio y su dirección de routing. Un TXT correcto con CNAME incorrecto pasa a `verified`, pero todavía no a `active`.

Resolver cadenas CNAME con una profundidad limitada y revisar A y AAAA finales. Aplicar un timeout de 5 segundos y limitar la frecuencia por dominio y actor. Mostrar los errores `txt_missing`, `txt_mismatch`, `dns_target_mismatch`, `dns_timeout` o `caa_blocked` cuando haya evidencia que los distinga. No diagnosticar CAA solo porque una prueba HTTPS falló.

La prueba de disponibilidad HTTPS requiere protección SSRF. El worker solo conectará a IPs públicas autorizadas para el ingress de la instancia, o a destinos de provider explícitos. Fijar la IP al abrir la conexión, conservando el hostname para SNI y Host. Rechazar loopback, metadata cloud, link-local y redes privadas salvo en una configuración de tests. No seguir redirects hacia otros orígenes.

### Provisión y activación

Secuencia persistida:

```text
pending_verification -> verified -> provisioning -> active
                                    |
                                    v
                                  error -> provisioning

active -> suspended
active/suspended/error -> removing -> removed
```

`verified` demuestra propiedad, `provisioning` permite preparar proxy y certificado, y `active` permite servir contenido. Si un site antiguo no ha migrado a raíz, el dominio puede prepararse pero no activarse para contenido hasta completar la migración.

El worker publica la ruta exacta de un dominio verificado. Antes de activarlo, comprueba TLS con validación de cadena y hostname y llama a `GET /__pb/domain-check` con un challenge temporal. Esa ruta responde desde PageBox para dominios en provisión y acredita que el proxy llegó a esta instancia. No devuelve archivos ni metadata del site. Funciona también para sites privados sin conceder una sesión.

El probe de TLS y el challenge deben superar la comprobación antes de registrar `active`. Tener un router escrito, obtener HTTP 200 o ver un certificado por defecto no demuestra que HTTPS esté listo para el dominio solicitado.

El worker vuelve a comprobar que `desiredRevision` no cambió antes de guardar el resultado. Si el usuario retiró el dominio durante la emisión, no lo reactiva con un resultado antiguo. Las operaciones aceptadas responden como pendientes; la interfaz consulta su estado.

### Reconciliación, retirada y fallos

Ejecutar una reconciliación al arrancar el worker y después cada 30 segundos. Elegir un único escritor mediante advisory lock de PostgreSQL. Usar una conexión reservada del worker y no mantener una transacción SQL abierta mientras espera a DNS, ACME o HTTP. Las réplicas web no escriben archivos de Traefik.

El provider file escribe una configuración completa determinista en un temporal del mismo directorio, la valida y la renombra. Montar el directorio padre, con `watch: true`, para que el reemplazo no rompa el watch de un archivo montado por separado. Traefik documenta esta condición en su [file provider](https://doc.traefik.io/traefik/v3.3/providers/file/).

Conservar la última configuración válida y un checksum de la revisión aplicada. Un fallo no borra los routers que estaban funcionando. Una operación de base de datos y una escritura al proxy no son atómicas; estados, revisiones y reconciliación permiten repetirlas después de un crash.

La retirada bloquea inmediatamente nuevas lecturas y revoca capacidades en la base de datos. El worker elimina la regla, verifica que el conjunto publicado ya no la incluye y marca `removed`. Si el proceso cae entre pasos, la aplicación sigue denegando el dominio y el worker retoma la retirada al arrancar.

El borrado de site debe dejar ese trabajo persistente antes de eliminar la fila. Deshabilitar un site conserva su dominio y certificado, pero devuelve 404. Cambiar su propietario conserva el dominio, registra la transferencia y exige los permisos actuales para gestionarlo.

Aplicar backoff a fallos de provisión, empezando en un minuto y hasta una hora, con variación entre dominios. Consultar [límites de Let's Encrypt](https://letsencrypt.org/docs/rate-limits/) al configurar cuotas de alta. Usar ACME staging en desarrollo. El propio Traefik mantiene el estado de certificados y su renovación; PageBox solo observa disponibilidad y alertas.

Revisar DNS una vez al día. Un timeout deja el resultado como desconocido y provoca un reintento. Proponer suspensión tras siete días de resultados concluyentes sin TXT válido o sin routing esperado, con aviso visible al propietario y auditoría. No suspender un dominio por un único fallo de red. La reactivación requiere nueva verificación y una versión de asociación nueva.

No compartir `acme.json` entre réplicas de Traefik esperando coordinación automática. La primera topología soportada tiene un emisor ACME. Alta disponibilidad del proxy requiere una estrategia de certificados propia; varias réplicas web de PageBox no cambian esa restricción.

### Reutilización de un hostname

El subdominio generado cambia cuando se borra y recrea un site. Un dominio personalizado puede conservar cookies y service workers de su uso anterior en el navegador. Pasar a raíz permite que un service worker tenga scope `/`, incluido el callback reservado.

Por eso un hostname que llegó a servir se reserva para su `boundSiteId` y no se asigna automáticamente a otro site. La retirada conserva una reserva histórica. No ofrecer un botón que prometa limpiar los navegadores de todos los visitantes. Un dominio previamente alojado fuera de PageBox también puede tener estado del navegador; la prueba DNS no demuestra que ese estado desapareció. Registrar esta limitación y usar un hostname nuevo para cambios de propietario con contenido de distinta confianza.

## API y panel

La gestión del dominio exige permiso `owner`, sesión del panel y la protección actual de mutations. Los deploy tokens existentes siguen autorizando builds y activaciones compatibles; no podrán reclamar, retirar o cambiar dominios. El superadmin configura providers, límites y nombres reservados.

Endpoints propuestos en el host del panel:

| Método y ruta | Resultado |
| --- | --- |
| `GET /api/v1/sites/<slug>/domains` | Dominio, instrucciones DNS y estado. Solo propietario o superadmin. |
| `POST /api/v1/sites/<slug>/domains` | Crea la solicitud, responde 201 y devuelve instrucciones DNS. |
| `POST /api/v1/sites/<slug>/domains/<id>/verify` | Encola verificación, responde 202. |
| `POST /api/v1/sites/<slug>/domains/<id>/activate` | Solicita provisión o activación, responde 202. |
| `DELETE /api/v1/sites/<slug>/domains/<id>` | Bloquea acceso y encola retirada, responde 202. |
| `POST /api/v1/sites/<slug>/routing/root/prepare` | Anuncia destino raíz y una revisión de migración. |
| `POST /api/v1/sites/<slug>/routing/root/commit` | Publica un deployment compatible y cambia el modo en una transacción. |

Implementar guards de sesión específicos para la gestión. No reutilizar sin revisión `identifyCaller`, que admite deploy tokens. Cada lookup de dominio exige también su `siteId`; conocer un ULID no autoriza la acción. Auditoría y escritura deben confirmarse juntas. Repetir `verify`, `activate` o `DELETE` no duplica registros ni trabajo. Una petición de alta repetida sobre el mismo site y hostname devuelve su solicitud existente.

`whoami` conserva sus campos existentes y añade:

```json
{
  "basePath": "/s/docs/",
  "siteUrl": "https://docs-<site-id>.pages.example.com/s/docs/",
  "mode": "subdomain",
  "routingMode": "path",
  "hostnameKind": "generated",
  "routingRevision": 3,
  "deploymentTarget": {
    "basePath": "/",
    "siteUrl": "https://docs-<site-id>.pages.example.com/",
    "routingRevision": 4,
    "requiresMigrationCommit": true
  }
}
```

El ejemplo corresponde a un site que prepara una migración. Sin migración pendiente, `deploymentTarget` coincide con el modo activo. Mantener `mode: 'subdomain'` durante la compatibilidad de API y documentar su deprecación; `routingMode` describe la ruta y `hostnameKind` el dominio. Después de la migración, `basePath` será `/` y `siteUrl` elegirá el dominio personalizado si está activo.

Añadir `buildBasePath` y `routingRevision` como parámetros de la subida ZIP. Se validan contra el destino autorizado y se guardan en el deployment. Un cliente antiguo sin esos parámetros usa el modo activo, nunca un destino de migración pendiente. Para CI que pueda cambiar de modo, exigir revisión explícita antes de activar y responder 409 si cambió mientras construía. No sobrescribir silenciosamente el contrato del build al reconsultar `siteRef`.

En el detalle del site, añadir una sección "Dominio" con el hostname, TXT copiable, CNAME o IPs, estado de DNS, proxy y HTTPS, fecha del último intento y botón de reintento. Mostrar la URL personalizada como principal solo cuando esté activa, y conservar visible la dirección de respaldo. Separar el permiso de configurar dominios del permiso de desplegar.

Para un site antiguo, mostrar "Publicar en raíz" con el destino del próximo build, el deployment preparado y la acción de confirmación. No hacer que el usuario cambie el dominio para descubrir después que también necesitaba reconstruir el site.

## Migración de builds y rollback

### Site nuevo

1. Crear el site con `basePath: '/'`.
2. Construir para raíz y subir como hasta ahora.
3. Comprobar páginas y assets en el subdominio generado.
4. Solicitar, verificar y activar el dominio personalizado.

El dominio puede configurarse antes de subir el primer build, pero la interfaz debe distinguir "HTTPS listo" de "contenido publicado".

### Site existente bajo `/s/<slug>/`

1. Guardar el deployment activo, modo y revisión actuales. Conservar el build previo mientras dure la migración.
2. Preparar la migración a raíz. `whoami` sigue describiendo el site servido y anuncia el destino nuevo en `deploymentTarget`.
3. Reconstruir para `/`. Para Next export, eliminar el prefijo y mantener `output: 'export'` e imágenes sin optimizador. Para SvelteKit static, usar base vacía; los ejemplos de raíz deben respetar cada generador.
4. Subir el build con `activate=false`, `buildBasePath=/` y la revisión pendiente. No cambiar el modo servido.
5. Ejecutar la verificación de assets contra ese deployment y contra la dirección de destino. Revisar el build y, en la primera versión, hacer una comprobación de navegador durante una ventana breve de cambio. No implementar un preview por path que vuelva a introducir basepaths en un build a raíz.
6. Confirmar con permiso `owner`. Bajo el lock de almacenamiento, releer site, revisión, deployment `ready` y compatibilidad. Cambiar `site.basePath`, deployment activo y revisión en una única transacción con auditoría.
7. Comprobar navegación, rutas profundas y login privado desde el subdominio. Activar el dominio personalizado si su routing y TLS están listos.
8. Mantener redirects de enlaces históricos y observar errores de assets y de canje.

Durante la preparación, fijar el deployment de rollback y el deployment raíz seleccionado para que retention no los pode. La operación de confirmación debe compartir la coordinación de activación y borrado existente, sin mantener conexiones ocupadas con DNS o probes externos. Liberar esas reservas al cancelar la migración o al cerrar su ventana de rollback.

Rollback de contenido en modo raíz solo admite deployments construidos para raíz. Volver al modo antiguo requiere otra operación que restaure juntos `basePath` y el deployment compatible y suspenda el dominio personalizado. Retirar el dominio conservando el modo raíz es distinto: el site continúa por su subdominio de respaldo. Una reversión de aplicación no debe apuntar a una versión que desconozca el nuevo esquema o los nuevos modos activos.

No reescribir HTML, CSS o JavaScript almacenado para eliminar `/s/<slug>/`. No cambiar todos los `basePath` con un `UPDATE` global. PageBox almacena builds que ya existen; la aplicación no puede reconstruirlos.

## Preflight y verificación de assets

Con `basePath: '/'`, una referencia `/assets/app.js` es correcta. El filtro actual la aceptaría, pero también aceptaría `/s/docs/assets/app.js`, aunque ese archivo ya no exista en esa ruta. Añadir un aviso específico de prefijo anterior cuando el site esté migrando.

Las recetas de raíz deben omitir los ajustes de prefijo innecesarios y conservar los requisitos de exportación estática. Un string vacío es válido para `basePath` de Next y `kit.paths.base`; `/` es el valor público que expone PageBox. No enseñar al usuario a poner `/` en una opción que pide base vacía.

Extender `verifyDeployment` para recibir el destino de build, no depender solo del `SiteRef` servido. Usar el mismo decodificador de paths que el servidor de archivos. Comprobar referencias de assets con resolución literal, sin dar por bueno un JS inexistente porque el SPA fallback devuelve `index.html`. Los enlaces de navegación sí pueden usar las reglas de resolución de páginas.

La comprobación actual solo lee `index.html` y 25 referencias, y el preflight muestrea 10 HTML. Mantener esos límites explícitos o ampliarlos con un presupuesto de trabajo. No presentar cero referencias rotas como prueba de que todo el site funciona.

## Entrega por fases

| Fase | Implementación | Criterio para cerrarla |
| --- | --- | --- |
| 0. Confirmar infraestructura | Inventario de valores de `site.hostname`, versión Dokploy, entrada pública o Tunnel, DNS wildcard, cobertura TLS y ownership del directorio de Traefik. Registrar la decisión de provider y actualizar la decisión antigua de TLS. | Topología y modo de provisión escritos. Un dominio de prueba tiene una ruta HTTPS viable. |
| 1. Servir desde raíz | Direcciones tipadas, resolver por ID, paths en raíz, separación de hosts centrales y callbacks, creación de sites nuevos y recetas de generadores. | Un build con referencias `/...` funciona sin configuración de prefijo, público y privado. |
| 2. Migrar sin romper el build activo | Campos de deployment, destino pendiente en `whoami`, revisión, subida diferida, confirmación y rollback coordinados con retention y locks. | Un site antiguo continúa sirviendo durante la preparación; el cambio publica modo y build juntos. |
| 3. Gestionar dominios | Tabla y migración de lectores, normalización, unicidad, TXT, lifecycle, API de propietarios, panel y provider manual. | Un dominio configurado por el operador pasa verificación, HTTPS y login, y al retirarlo deja de servir inmediatamente. |
| 4. Automatizar Traefik | Worker separado, directorio dinámico, reglas exactas, ACME, probe, revisiones, retries y retirada tras borrado de site. | Añadir y retirar dominios no requiere redeploy de la aplicación; un crash no deja el estado incoherente. |
| 5. Validar y documentar | Suite HTTP y Chromium, proxy/TLS en entorno aislado, staging ACME, guía Dokploy/Tunnel y pruebas de restauración. | Checks del repositorio pasan y los resultados distinguen verificación local de pruebas con DNS público. |

Las fases 1 y 2 permiten dejar de usar basepath con los subdominios de PageBox. La fase 3 ya permite dominios personalizados completos con provisión manual. La fase 4 evita que el operador tenga que crear cada ruta. Si la instalación solo admite Tunnel, sustituir el provider de la fase 4 por una entrega de Cloudflare for SaaS antes de prometer alta automática de dominios externos.

Configuración nueva propuesta:

| Variable | Uso |
| --- | --- |
| `PAGEBOX_CUSTOM_DOMAINS_ENABLED` | Habilita gestión de dominios en una instancia preparada. |
| `PAGEBOX_DOMAIN_PROVIDER` | `manual` o `traefik-file`. |
| `PAGEBOX_DOMAIN_CNAME_TARGET` | Nombre público estable que muestra el panel. |
| `PAGEBOX_DOMAIN_INGRESS_IPS` | IPs autorizadas de destino y probes. |
| `PAGEBOX_DOMAIN_RESERVED_HOSTS` | Hosts de infraestructura que no pueden reclamar los sites. |
| `PAGEBOX_DOMAIN_LIMIT_PER_OWNER` | Cuota de solicitudes y dominios para contener abuso y emisiones. |
| `PAGEBOX_TRAEFIK_DYNAMIC_DIR` | Directorio exclusivo del worker para su archivo dinámico. |
| `PAGEBOX_TRAEFIK_CONTENT_SERVICE` | Servicio fijo, si la instalación ya lo declara en otro archivo. |
| `PAGEBOX_TRAEFIK_CERT_RESOLVER` | Resolver definido por el operador. |

El worker tendrá acceso de escritura solo a su directorio. El contenedor web no necesita Docker socket, credenciales de Dokploy ni claves del proveedor DNS de clientes. Los secretos de ACME DNS-01 para el wildcard de la plataforma pertenecen al proxy.

Conservar Host público y configurar `PROTOCOL_HEADER` solo detrás de un proxy que lo sobrescriba. No fijar `ORIGIN` al panel, porque adapter-node reconstruiría todas las URLs con ese origen y rompería la clasificación. No copiar opciones de SvelteKit 3 a este proyecto de Kit 2. La [guía de adapter-node](https://svelte.dev/docs/kit/adapter-node) debe contrastarse con la versión instalada.

## Pruebas y criterios de aceptación

Extender los tests existentes en vez de sustituirlos. La suite futura debe cubrir:

| Área | Casos que deben pasar |
| --- | --- |
| Hosts | Mayúsculas, IDN, hostname exacto, ID válido con prefijo incorrecto, host reservado, dominio desconocido y separación panel/lector/contenido. |
| Paths en raíz | `/`, `/about`, `/about/`, assets, favicon, archivos con espacios y Unicode, traversal, separadores codificados, dotfiles y `__pb`. |
| Assets y HTTP | SPA, `404.html`, HEAD, ETag/304, ranges, compresión y cache policies actuales. Asset inexistente no validado por fallback SPA. |
| DNS | TXT válido ligado al site, TXT de otro site, CNAME incorrecto, cadena excesiva, AAAA incorrecto, timeout y reintentos limitados. |
| Permisos | Owner permitido, deployer y token de deploy rechazados para dominios, aislamiento entre administradores, conflictos sin filtrar información. |
| Login privado | Navegación inicia login, subrecurso anónimo devuelve 401, lector sin grant recibe 404, query de regreso conservada y cookie host-only. |
| Código y sesión | Canje en origen incorrecto, otro dominio del mismo site, esquema/puerto incorrecto, replay, expiración, concurrencia, retirada y cambio de versión. |
| Revocación | Logout, reset y retirada de grant bloquean el siguiente archivo por ambas direcciones. Un dominio retirado no funciona accediendo al backend. |
| Migración | Subida raíz no activa sobre modo antiguo, revisión obsoleta devuelve 409, commit coordinado, rollback compatible, retention y uploads concurrentes. |
| Proxy y TLS | Host preservado, certificado correcto, challenge de instancia correcto, falta de certificado y eliminación de rutas. |
| Recuperación | Crash antes y después de publicar archivo, revisión obsoleta, fallos de disco, retirada durante emisión y borrado del site con worker detenido. |
| Estado del navegador | Service worker de un site no alcanza el panel ni otro origen; reserva de hostname usado impide asignarlo a otro site. |

Usar los fixtures desechables de [test-stack.mjs](../scripts/test-stack.mjs), ampliados con hostnames personalizados locales, DNS controlado y un proxy que sobrescriba headers de confianza. No usar la base de desarrollo ni el homelab para tests destructivos. En Chromium, usar certificados de prueba confiados por el contexto para los checks de HTTPS; eso no sustituye la prueba de emisión ACME.

Checks previstos para la implementación:

```text
pnpm check
pnpm test
pnpm build
node scripts/test-stack.mjs
```

Añadir checks del worker y renderizado del router a [check-router.mjs](../scripts/check-router.mjs) o a un script equivalente. Ejecutar el check de formato vigente y revisar las migraciones generadas antes de publicarlas. Los `.md` están excluidos del formato global actual, así que su comprobación requiere una llamada explícita o una revisión independiente.

Para cerrar la entrega, probar un dominio público real con ACME staging, certificado de producción y renovación observada por el operador. Comprobar también un site privado desde un navegador limpio. Los certificados de prueba y el header Host local no acreditan que el DNS público o el edge de Cloudflare estén configurados.

## Documentación que debe acompañar la implementación

- Actualizar [README.md](../README.md), [deploy-api.md](deploy-api.md), [base-paths.md](base-paths.md), [dokploy.md](dokploy.md) y [DEPLOYMENT-SECURITY.md](../DEPLOYMENT-SECURITY.md) con raíz, dominio, cookies y migración.
- Corregir las afirmaciones antiguas de Compose, defaults de proxy y routing por dominio compartido. Mantener los planes originales identificados como antecedentes.
- Actualizar las páginas equivalentes de `gh-pages/content/docs`, las recetas interactivas y los scripts de publicación de la documentación cuando ese site migre. Respetar sus instrucciones locales y la versión instalada de Next.
- Documentar requisitos de TLS, topología Tunnel, retirada de dominios, límite de reutilización de hostnames y restauración de base de datos junto con configuración del proxy.
- Incluir ejemplos CI que distingan `basePath` servido de `deploymentTarget`, y que conserven revisión y compatibilidad al subir o activar.

La primera implementación debe empezar por servir un build real en `/` sobre el subdominio inmutable. Después se conecta ese mismo site a un dominio de prueba. Ese orden permite comprobar por separado la compatibilidad del build y la provisión de DNS/TLS, sin perder las protecciones de lector que el código ya tiene.
