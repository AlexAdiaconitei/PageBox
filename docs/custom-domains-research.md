# Investigación de dominios personalizados

Fecha de revisión: 2026-10-05.

Estas notas contrastan el comportamiento del framework y del proxy con fuentes oficiales. La investigación parte del repositorio y no incluye una inspección de la infraestructura activa. El plan principal está en [PLAN-custom-domains.md](PLAN-custom-domains.md).

## SvelteKit 2 y adapter-node 5.5.7

El código de la versión 5.5.7 construye cada `Request` con `ORIGIN || get_origin(req.headers)`. Un `ORIGIN` fijo sustituye el origen de todos los hosts y afecta a `event.url`. Si PageBox resuelve el site con `event.url.hostname`, debe quitar ese valor fijo. Esto se comprobó tanto en el paquete instalado como en el [handler de la versión 5.5.7](https://github.com/sveltejs/kit/blob/%40sveltejs/adapter-node%405.5.7/packages/adapter-node/src/handler.js).

La misma versión usa `HOST_HEADER` si se configura y recurre a `Host` si falta. Obtiene el esquema de `PROTOCOL_HEADER` y, sin él, usa `https`. Por tanto, conservar `Host` y establecer `PROTOCOL_HEADER=x-forwarded-proto` en una red privada detrás del proxy permite representar el origen solicitado. `HOST_HEADER=x-forwarded-host` solo hace falta si el proxy cambia `Host`. El hostname obtenido todavía debe contrastarse con los dominios registrados en PageBox. Fuente: [código de adapter-node 5.5.7](https://github.com/sveltejs/kit/blob/%40sveltejs/adapter-node%405.5.7/packages/adapter-node/src/handler.js).

La [documentación actual de adapter-node](https://svelte.dev/docs/kit/adapter-node#PROTOCOL_HEADER-HOST_HEADER-and-PORT_HEADER) exige un proxy de confianza para leer cabeceras forwarded. Actualmente esa página también contiene cambios de SvelteKit 3 y `paths.origin`. No deben trasladarse al proyecto con SvelteKit 2 sin revisar la versión. El código fijado arriba es la referencia para `ORIGIN`.

Traefik permite confiar en `X-Forwarded-*` solo desde IP o CIDR concretos con `forwardedHeaders.trustedIPs`. `forwardedHeaders.insecure` confía en cualquier emisor. Si hay CDN o Tunnel delante, hay que documentar la cadena real de proxies y probar cabeceras falsas. Fuente: [entrypoints de Traefik 3.3](https://doc.traefik.io/traefik/v3.3/routing/entrypoints/#forwarded-headers).

## Traefik 3.3 y configuración dinámica

El file provider admite routers y servicios en YAML o TOML y recarga cambios con `watch: true`. Traefik recomienda montar el directorio padre y usar `providers.file.directory`. Reemplazar un archivo que está montado individualmente puede romper el vínculo del bind mount y dejar de producir actualizaciones. Fuente: [file provider de Traefik 3.3](https://doc.traefik.io/traefik/v3.3/providers/file/#provider-configuration).

La escritura de temporal y rename dentro del mismo sistema de archivos es una recomendación de implementación para evitar que Traefik lea YAML incompleto. Debe usarse un directorio montado, validar antes de publicar y comprobar el resultado por HTTP. La documentación explica la recarga, pero no ofrece una transacción conjunta entre base de datos y proxy. Hay que reconciliar ambos estados y admitir reintentos.

## Certificados y DNS

- HTTP-01 exige que Let's Encrypt alcance el puerto público 80. Traefik necesita un resolver estático y cada router HTTPS debe referenciarlo. Un router `Host` permite inferir el nombre solicitado. Añadir routers dinámicos no configura por sí solo entrypoints ni resolvers. Fuente: [ACME de Traefik 3.3](https://doc.traefik.io/traefik/v3.3/https/acme/).
- HTTP-01 permite emitir certificados para dominios que apuntan por CNAME al proveedor. No permite wildcards. DNS-01 requiere publicar TXT en `_acme-challenge` y admite delegar esa zona por CNAME o NS. Automatizar renovaciones exige una API DNS o delegación controlada. Fuente: [tipos de challenge de Let's Encrypt](https://letsencrypt.org/docs/challenge-types/).
- Un wildcard de la plataforma no certifica dominios de clientes ajenos. Para esos hosts hay que emitir certificados concretos o usar un proveedor que los gestione. Es una consecuencia del alcance de los nombres del certificado, no una configuración que resuelva un `HostRegexp`.
- Traefik guarda ACME en `acme.json` con permisos `600`. Hay que persistirlo entre despliegues. La documentación prohíbe compartir ese archivo entre varias instancias concurrentes de Traefik. Para alta disponibilidad hará falta otro modelo de emisión y distribución. Fuente: [almacenamiento ACME de Traefik 3.3](https://doc.traefik.io/traefik/v3.3/https/acme/#storage).

Los límites vigentes de Let's Encrypt incluyen 300 órdenes por cuenta en 3 horas, 50 certificados por dominio registrable en 7 días, 5 certificados por el mismo conjunto exacto de identificadores en 7 días y 5 fallos de autorización por identificador y cuenta en una hora. Las renovaciones mediante ARI tienen excepciones, pero no se ha confirmado soporte ARI en la versión instalada. El worker debe respetar `Retry-After`, evitar bucles de provisión y usar staging durante pruebas. Fuente: [límites de Let's Encrypt](https://letsencrypt.org/docs/rate-limits/).

## Dokploy

Dokploy gestiona Application y Compose de forma distinta. Para Application crea un archivo dinámico por dominio y aplica cambios sin redesplegar. Su ejemplo conserva `Host` con `passHostHeader: true`. Para Compose genera labels de Docker y pide redesplegar al cambiar los dominios desde Dokploy. Fuente: [gestión de dominios de Dokploy](https://docs.dokploy.com/docs/core/domains#how-domains-are-managed).

Consecuencia para PageBox: no conviene prometer altas automáticas sin interrupción usando la pantalla de dominios de Compose. Si se conserva Compose, un reconciliador propio con file provider evita modificar labels en cada alta. Hay que comprobar qué directorio, red y resolver controla realmente Dokploy y separar los archivos de PageBox de los que genera Dokploy. Es una propuesta de diseño, no una capacidad ya comprobada del despliegue.

## Cloudflare Tunnel y dominios de clientes

El destino `<UUID>.cfargotunnel.com` solo acepta tráfico de registros DNS de la misma cuenta de Cloudflare. Un cliente en otra cuenta no puede activar su dominio apuntando directamente al UUID del túnel. Fuente: [DNS de Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/).

Cloudflare for SaaS incorpora dominios ajenos como custom hostnames y los envía a un fallback origin. Requiere habilitar el producto y crear cada hostname. La configuración ordinaria usa CNAME del cliente hacia un destino de la plataforma. Si el cliente necesita un registro A hacia el servicio, la documentación exige apex proxying. Fuente: [configuración de Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/).

Cloudflare documenta una arquitectura que usa Tunnel como fallback origin de Cloudflare for SaaS. Esto permite una alternativa al edge público. También señala cambios en `Host` cuando se incorporan balanceadores con public hostnames. Antes de escoger esta opción, hay que probar que la ruta final conserva o transmite de forma fiable el hostname original hasta PageBox. Fuente: [arquitectura oficial para proveedores SaaS](https://developers.cloudflare.com/reference-architecture/design-guides/extending-cloudflares-benefits-to-saas-providers-end-customers/).

En Cloudflare for SaaS, el estado del hostname y el del certificado son independientes. Solo está preparado para tráfico cuando `result.status` y `result.ssl.status` son `active` y el DNS apunta al destino SaaS. Fuente: [estados de validación](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/validation-status/).

Universal SSL en una zona con configuración DNS completa cubre `example.com` y sus subdominios de primer nivel. `site.pages.example.com` queda fuera de esa cobertura. Para el dominio predeterminado `*.pages.example.com` hay que contratar o cargar cobertura adicional en el edge de Cloudflare, usar una zona específica o terminar TLS con un certificado adecuado fuera del proxy de Cloudflare. La configuración CNAME parcial tiene otras reglas. Fuente: [limitaciones de Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/#hostname-coverage).

## Reutilización de un hostname

Un service worker con scope `/` puede interceptar peticiones de todo ese origen. La especificación establece que los registros persisten más allá de la vida de los objetos que los representan. Borrar un site en el servidor no borra los registros del navegador de sus visitantes. Fuente: [registro de service workers en la especificación W3C](https://w3c.github.io/ServiceWorker/#service-worker-registration-concept).

Consecuencia de diseño: los subdominios predeterminados deben pertenecer a un site de forma permanente. Para dominios personalizados, reservar el hostname eliminado y permitir recuperarlo solo para el mismo `siteId` evita que otro site herede un origen con workers, cachés o almacenamiento anteriores. Esa reserva es una política propuesta para el MVP. La especificación describe persistencia y scope, no exige dicha política. Si se necesita transferir un dominio entre sites, habrá que diseñar una limpieza y migración que trate los navegadores ya registrados.

## Decisión recomendada para la implementación

Preparar primero resolución por hostname, verificación de propiedad y un reconciliador con estados explícitos. Para un servidor con IP pública y 80/443 disponibles, Traefik con file provider y HTTP-01 es la opción con menos dependencias nuevas. Para un servidor accesible solo por Tunnel, Cloudflare for SaaS merece una prueba de concepto antes de comprometer la arquitectura.

La verificación TXT de PageBox demuestra que el usuario controla el dominio. ACME o Cloudflare verifican y emiten TLS. Son comprobaciones distintas y el estado `active` debe requerir ambas, además de una comprobación de que el site correcto responde por HTTPS.
