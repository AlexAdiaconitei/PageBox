# Evaluación de seguridad previa al lanzamiento

Revisión del commit `5b1b0c92de2bed9a676b4146312670ae7dd774d1`, realizada el 4 de octubre de 2026 UTC.

Yo frenaría el lanzamiento público hasta corregir los siete primeros hallazgos. Hay fallos reproducidos de aislamiento, toma de cuentas, revocación de sesiones y disponibilidad. Que el homelab funcione y que las pruebas pasen no cubre estos escenarios.

El riesgo inmediato es menor si solo una persona publica contenido de confianza y la instancia está limitada a una red privada. El código actual no ofrece aislamiento seguro entre autores independientes. Esta revisión no ha inspeccionado ni atacado el homelab y no permite afirmar que haya ocurrido una intrusión.

## Alcance y comprobaciones

Revisados los hooks de SvelteKit, las dos instancias de Better Auth, sesiones, permisos, grupos, administración de cuentas, API de despliegue, extracción ZIP, cuotas, retención, acceso a S3, cachés, configuración, Docker y workflows. También se consultaron los dos lockfiles y la configuración de exportación estática de la documentación.

Las reproducciones usaron dos servidores locales construidos con `pnpm build`, PostgreSQL 16 y MinIO en contenedores desechables. Todos los datos y credenciales eran fixtures. Se usaron los puertos de loopback 13000, 13001, 15432 y 19000. No se modificó el código de la aplicación.

| Comprobación | Resultado |
| --- | --- |
| `pnpm check` | 0 errores, 0 avisos de svelte-check |
| `pnpm build` | Correcto; avisos sobre CSRF deprecado, CSS y una anotación de Rollup |
| `pnpm test` | 112 pruebas unitarias correctas; 82 de integración omitidas sin configuración |
| Integración contra la instancia aislada | 82 pruebas correctas en las 9 suites |
| `pnpm audit --json`, aplicación | 11 avisos: 3 altos, 6 moderados y 2 bajos |
| `pnpm audit --json`, documentación | 14 avisos: 3 críticos, 8 altos y 3 moderados |

Los avisos de dependencias no equivalen a ese número de vulnerabilidades explotables en PageBox. Algunos afectan a desarrollo o requieren funciones que el proyecto no expone. El detalle está en S13.

Los resultados de las reproducciones están en [security-review/evidence.json](security-review/evidence.json). Los inventarios del registro están en [security-review/app-dependencies.json](security-review/app-dependencies.json) y [security-review/docs-dependencies.json](security-review/docs-dependencies.json).

## Prioridades

La gravedad describe el impacto en este proyecto. No es una puntuación CVSS. "Reproducido" indica que se ejecutó el escenario; "condicional" requiere una configuración o conducta concreta.

| ID | Gravedad | Hallazgo | Evidencia |
| --- | --- | --- | --- |
| S01 | Alta | Un sitio puede leer otros sitios privados con la sesión del visitante | Diseño y solicitud HTTP reproducida |
| S02 | Alta | El administrador emisor puede tomar una cuenta promovida a administrador | Reproducido por HTTP |
| S03 | Alta | El reset administrativo conserva las sesiones anteriores | Reproducido por HTTP y consulta a PostgreSQL |
| S04 | Alta | La API permite desplegar durante el cambio obligatorio de contraseña | Reproducido por HTTP |
| S05 | Alta | Los locks pueden agotar el pool y bloquear la base de datos para la aplicación | Reproducido con la función real y PostgreSQL |
| S06 | Alta | Activación y borrado concurrentes pueden eliminar el despliegue activo | Reproducido por HTTP con intercalado controlado |
| S07 | Alta | Un borrado parcial de S3 se informa como completado | Reproducido con la función real y respuesta S3 simulada |
| S08 | Media | Quitar una membresía no invalida el permiso ya calculado | Reproducido por HTTP |
| S09 | Media | Promover a administrador deja una cuota ilimitada; otros cambios no comparten los locks | Promoción reproducida; resto por revisión |
| S10 | Alta, condicional | Compose publica servicios con credenciales de ejemplo en todas las interfaces | Configuración del repositorio |
| S11 | Media, condicional | Una cadena de proxies termina en un limitador compartido; el puerto directo permite falsear la IP | Cadena reproducida y configuración |
| S12 | Media | El ZIP conserva dotfiles y puede convertir una carpeta oculta en archivos públicos | Reproducido por HTTP |
| S13 | Media | Dependencias con avisos pendientes, incluidas dependencias usadas por SSR | Lockfiles, registro y avisos oficiales |
| S14 | Media, condicional | Cualquier cabecera Bearer omite CSRF, incluso en acciones autenticadas por cookie | Reproducido por HTTP; sin exploit de navegador externo |
| S15 | Baja | Archivos con espacios o caracteres Unicode se suben pero responden 404 | Reproducido por HTTP |

## Hallazgos bloqueantes

### S01. Los sitios comparten la sesión y el origen del navegador

Referencias: `src/lib/server/sites/resolve.ts:59`, `src/lib/server/sites/serve.ts:76`, `src/hooks.server.ts:60` y `src/lib/server/auth/index.ts:163`.

Los sitios se publican en `pages.example.com/s/<slug>/`. El navegador no considera la ruta parte del origen. Una página alojada en `/s/malicioso/` puede ejecutar:

```js
const contenido = await fetch('/s/privado/documento.txt').then(r => r.text());
```

Si el visitante tiene permiso de lectura sobre el sitio privado, su cookie de lectura viaja con la petición y el script obtiene los bytes. No necesita leer una cookie HttpOnly, conocer una contraseña ni vulnerar el control de permisos del servidor. El servidor autentica al visitante, pero el navegador permite al autor de la página leer la respuesta. La definición del origen depende de protocolo, host y puerto, como explica [MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).

La reproducción HTTP envió la petición equivalente desde el sitio público, con la sesión del lector. Obtuvo `200` y `audit-secret-content`. Esta prueba no automatizó un navegador; la capacidad del script deriva de la regla de mismo origen y de la ausencia de una separación entre sitios.

También se comparte el origen con `/login` del host de sitios. Por tanto, esa página tampoco está aislada del JavaScript alojado. La limitación de scope de un service worker no impide una lectura normal mediante `fetch`.

Separar el panel protege su cookie, pero no resuelve este problema entre sitios. Antes de admitir autores independientes, cada sitio debe tener su propio origen y una sesión de lectura vinculada a ese sitio. El inicio de sesión puede residir en un origen de confianza y entregar una autorización breve, de un solo uso, al origen de destino. No compartir cookies mediante `Domain` entre todos los sitios. Mientras se mantenga este diseño, todos los autores deben ser de confianza para todo el contenido privado de la instancia.

### S02. Un administrador puede tomar a un antiguo usuario después de su promoción

Referencias: `src/lib/server/perms.ts:221` y `src/routes/(panel)/users/+page.server.ts:186`.

`manages()` excluye al superadmin y al propio actor, pero para los administradores solo comprueba `target.createdByUserId === actor.id`. No rechaza un objetivo cuyo rol actual sea `admin`. La promoción conserva la atribución al emisor.

Reproducción por las acciones reales del panel:

1. El superadmin crea al administrador A.
2. A crea al usuario B.
3. El superadmin promueve B a administrador.
4. A resetea la contraseña de B.
5. A inicia sesión como B con la nueva contraseña.

El reset respondió `success`, y el inicio de sesión como B funcionó. A puede acceder a lo que B posee aunque no tenga grants sobre esos sitios. La misma condición afecta a suspensión y a otras acciones que usan `manages()`.

Los administradores deben poder administrar exclusivamente cuentas con rol actual `user`, salvo una política explícita distinta. Al promover, conviene transferir también la administración de la cuenta al superadmin. La prueba existente de pares usa dos administradores creados por el superadmin y no cubre esta transición.

### S03. El reset de contraseña no revoca las sesiones

Referencia: `src/routes/(panel)/users/+page.server.ts:350`.

La acción llama a `adminAuth.api.setUserPassword()` y cambia `mustChangePassword`. En Better Auth 1.6.26, la implementación instalada de ese endpoint cambia el hash, pero no elimina sesiones. PageBox tampoco las revoca después.

Antes del reset había dos sesiones para el usuario, una del panel y otra de lectura. Después seguían las mismas dos. La cookie anterior de lectura recibió `200` al pedir un archivo privado.

Si se resetea la contraseña por una cuenta comprometida, el atacante conserva acceso con sus cookies anteriores. Revocar todas las sesiones de ambos scopes como parte del reset, y probar expresamente que ambas cookies quedan rechazadas. El script de recuperación ya revoca sesiones; la acción del panel debe ofrecer una garantía equivalente. La revocación de API keys requiere una política propia, porque cambiar una contraseña no cambia automáticamente esas credenciales.

### S04. La API salta el cambio obligatorio de contraseña

Referencias: `src/hooks.server.ts:105`, `src/lib/server/api/context.ts:99` y `src/lib/server/api/context.ts:51`.

El hook exige cambiar la contraseña en páginas del panel, pero excluye `/api/*`. `identifyCaller()` no comprueba `mustChangePassword`, y `tokenOwner()` lee esa bandera sin usarla para denegar operaciones.

Con la sesión previa de un usuario reseteado, `/sites` redirigió a `/account/password`. La misma sesión publicó un ZIP por `/api/v1/sites/audit-reset/deployments` y recibió `201`.

La restricción debe formar parte de la autorización de las operaciones, tanto para cookies como para tokens según la política elegida. Denegar las mutaciones con una respuesta explícita hasta completar el cambio. Una redirección de la interfaz no aplica esa garantía a la API.

### S05. Los locks pueden bloquear todo el pool

Referencias: `src/lib/server/quota.ts:67`, `src/lib/server/db/index.ts:17` y `src/lib/server/db/migrate.ts:27`.

`withQuotaLock()` reserva una conexión del pool y espera un `pg_advisory_lock` bloqueante. Su callback consulta mediante el `db` global, que necesita otra conexión del mismo pool.

Con un pool de dos conexiones y dos operaciones para el mismo propietario, la primera conserva el lock y la segunda reserva la conexión restante para esperar ese lock. La primera necesita una conexión libre para ejecutar el callback. Ninguna puede avanzar.

La reproducción usó la función compilada real. Tras un segundo había cero operaciones completadas, un lock concedido y otro pendiente. No era una consulta lenta. El ciclo no puede resolverse solo. Con `DATABASE_POOL_MAX=1`, permitido por la configuración, una sola operación que reserve y luego consulte el pool ya puede bloquearse. Las migraciones tienen la misma necesidad de una conexión adicional.

Usar la conexión reservada para las consultas protegidas, pasando al callback una instancia de Drizzle vinculada a esa conexión, y limitar el tiempo de espera. No mantener conexiones del pool ocupadas esperando sin límite. Añadir pruebas con un pool pequeño y con más peticiones simultáneas que conexiones. La semántica de reserva está documentada en [Postgres.js](https://github.com/porsager/postgres#reserve).

### S06. Borrado y activación pueden dejar el sitio apuntando a un despliegue inexistente

Referencias: `src/routes/api/v1/sites/[slug]/deployments/[id]/+server.ts:33`, `src/lib/server/deploy/ingest.ts:250`, `src/lib/server/deploy/retention.ts:64` y `src/routes/(panel)/sites/[slug]/+page.server.ts:280`.

El borrado decide si puede eliminar usando un `SiteRef` leído antes. Luego elimina objetos y la fila. La activación comprueba por separado que el despliegue está listo y mueve el puntero. No comparten una exclusión por sitio. La retención también recibe una instantánea del puntero activo.

Para reproducir el intercalado de forma determinista, se mantuvo un lock de fila de PostgreSQL que pausaba el DELETE después de borrar S3 y antes de eliminar la fila. Se activó ese mismo despliegue y luego se dejó terminar el borrado. Ambas peticiones respondieron `200`; `active_deployment_id` quedó definido y `active_row_exists` era `false`.

El sitio deja de servir. También puede ocurrir con la retención o con otro operador activando un build mientras se borra. Compartir un lock por sitio entre activación, borrado, retención y operaciones de ciclo de vida. Releer el puntero bajo ese lock, marcar un despliegue como en proceso de borrado y rechazar su activación. El esquema debe impedir referencias activas a despliegues ajenos o inexistentes, además del control de la aplicación.

### S07. El borrado de S3 ignora errores por objeto

Referencia: `src/lib/server/s3.ts:130`.

`deletePrefix()` descarta la respuesta de `DeleteObjectsCommand` y suma todos los objetos solicitados como borrados. S3 puede responder HTTP 200 incluyendo errores individuales. Con `Quiet: true`, esos errores siguen formando parte de la respuesta. El contrato está documentado por [AWS](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html).

La reproducción usó el cliente SDK y la función real contra un endpoint local que devolvía una respuesta S3 válida con `AccessDenied` para el único objeto. La función devolvió `1` y no lanzó un error, aunque se habían borrado cero objetos.

Los callers eliminan entonces filas y contabilizan espacio liberado. Puede quedar contenido sensible en almacenamiento sin una referencia que permita localizarlo desde el panel. Además, el sweeper marca como fallidos uploads cuya limpieza lanzó un error y no vuelve a seleccionarlos, porque solo busca `uploading`.

Comprobar `Errors` en cada lote, conservar un estado de limpieza pendiente y reintentar los objetos fallidos. Contar solo borrados confirmados. No prometer "no se eliminó nada" después de un fallo de una operación de varios lotes, porque algunos objetos pueden haber desaparecido. Si se permite versionado del bucket, definir también si se deben eliminar versiones anteriores.

## Otros problemas que conviene corregir

### S08. La revocación de membresía deja acceso durante el TTL

Referencias: `src/lib/server/perms.ts:57`, `src/lib/server/perms.ts:69` y `src/routes/(panel)/groups/+page.server.ts:190`.

La eliminación de un miembro invalida `groups:<userId>`, pero no `perm:<siteId>:<userId>`. `permissionFor()` devuelve el permiso ya calculado sin volver a consultar grupos.

Después de eliminar la membresía por el panel, PostgreSQL tenía cero filas para ese usuario y el archivo privado seguía respondiendo `200`. El permiso almacenado puede seguir válido hasta su TTL de 60 segundos. Los tokens del usuario también consultan ese permiso.

Invalidar los permisos de los sitios que tengan grants para ese grupo al cambiar membresías, o incluir una versión de permisos del usuario en las claves. La caché compartida necesita además evitar que una lectura iniciada antes de revocar vuelva a guardar un permiso antiguo después de invalidarlo. La documentación actual promete efecto inmediato y debe coincidir con la garantía real.

### S09. Las transiciones de rol y propiedad rompen las cuotas

Referencias: `src/routes/(panel)/users/+page.server.ts:224`, `src/lib/server/quota.ts:289`, `src/routes/(panel)/users/+page.server.ts:297` y `src/routes/(panel)/sites/[slug]/+page.server.ts:326`.

Un usuario normal tiene `storageQuotaBytes = null`. Promoverlo conserva ese `null`, y `quotaFor()` lo interpreta como ilimitado. La reproducción promovió un usuario, creó su sitio y aceptó un build de 6 MB con una cuota por defecto de 5 MB. La consulta confirmó `role = admin` y `storage_quota_bytes = null`.

El backfill lo cambia en el siguiente arranque, pero no protege el periodo anterior y puede crear asignaciones que superen el pool. La transferencia de la plaza también demueve al superadmin sin asignarle una cuota. La transferencia de sitios comprueba uso y cambia dueño sin participar en los locks de gasto de ambos propietarios. La asignación del pool y el gasto del superadmin usan locks separados aunque sus cálculos dependan entre sí.

Toda entrada al rol `admin` debe asignar y validar una cuota bajo la misma regla de asignación. La transferencia debe coordinar a ambos propietarios y releer su uso. El gasto del superadmin debe serializarse con los cambios que reducen su capacidad. Estas condiciones hacen que la cuota actual no sea un límite duro en todas las transiciones.

Hay también un fallo de presentación en `src/routes/(panel)/sites/+page.server.ts:50`: pasa `storageQuotaBytes: null` en lugar de leer la cuota del administrador, por lo que la lista muestra una asignación distinta de la que se aplica al desplegar.

### S10. Los valores de Compose son peligrosos si se publican sin adaptación

Referencias: `docker-compose.yml:24`, `docker-compose.yml:45`, `docker-compose.yml:50`, `docker-compose.yml:63` y `docker-compose.yml:67`.

Compose publica PostgreSQL, la API de MinIO, su consola y el puerto directo de PageBox sin una dirección de enlace, por tanto en todas las interfaces del host. Los fallbacks son `pagebox` para PostgreSQL y `pagebox / pageboxpagebox` para el usuario root de MinIO.

La validación de placeholders de PageBox solo comprueba el secreto de autenticación y la contraseña bootstrap en ciertas configuraciones. No protege estas credenciales de infraestructura. Tener hostnames reales y una contraseña fuerte del panel no cierra PostgreSQL ni MinIO.

Además, `isReachable()` en `src/lib/server/config.ts` asume que configurar `.localhost`, `.local` o `.test` implica que nadie externo puede llegar. Eso no determina en qué interfaces escucha el servidor. Un cliente que alcanza el puerto puede enviar el hostname esperado en sus cabeceras. Conservar credenciales de ejemplo basándose solo en ese sufijo no protege una instancia publicada.

Si esos puertos llegan a una red no confiable y se conservan los defaults, se puede acceder directamente a la base de datos o al almacenamiento y evitar todos los permisos de PageBox. No se ha comprobado si ocurre en tu homelab. Para producción, retirar los puertos innecesarios, enlazar las herramientas locales a `127.0.0.1`, exigir credenciales elegidas y usar una clave de almacenamiento limitada al bucket. El puerto de la aplicación debe admitir tráfico únicamente del proxy de confianza cuando se usan sus cabeceras para autenticar la dirección del cliente.

### S11. La IP del limitador no usa la configuración de profundidad del proxy

Referencias: `src/lib/server/auth/index.ts:163`, `src/lib/server/auth/credentials.ts:48` y `deploy/entrypoint.sh:50`.

La aplicación configura `XFF_DEPTH` para adapter-node, pero reenvía a Better Auth el `X-Forwarded-For` original cuando existe. Better Auth 1.6.26 rechaza cadenas con varias direcciones salvo que se configuren proxies confiables, que aquí no se configuran.

Una petición con `X-Forwarded-For: 198.51.100.33, 192.0.2.10` creó el contador `no-trusted-ip|/sign-in/email`. Distintos usuarios en esa situación comparten el mismo presupuesto de intentos. Agotarlo puede impedirles iniciar sesión. Cambiar `XFF_DEPTH` no modifica ese resultado.

Si el puerto directo publicado admite cabeceras del cliente, una IP arbitraria de un solo valor sí se acepta. Eso permite repartir intentos entre contadores y falsear la atribución. La protección efectiva depende del proxy y de bloquear ese acceso directo.

Resolver una sola dirección validada en el límite de confianza y suministrarla a Better Auth, o configurar `trustedProxies` de acuerdo con la cadena real. Añadir pruebas que usen varios saltos, cabeceras ausentes y cabeceras aportadas por un cliente no confiable. Los comentarios de `.env.example` también deben corregirse: prometen contadores por cuenta y solo de fallos, mientras el código usa el limitador por IP/ruta y cuenta solicitudes.

### S12. Los dotfiles no se excluyen en el servidor antes de elegir la raíz

Referencias: `src/lib/server/deploy/zip.ts:74`, `src/lib/server/deploy/zip.ts:119` y `src/lib/preflight.ts:40`.

El preflight del navegador excluye rutas ocultas. `safeEntryPath()` del servidor no aplica esa regla. Un ZIP normal puede guardar `.env` y `.git` en S3 aunque no sean accesibles con su nombre original en HTTP.

Además, si todos los archivos están dentro de una carpeta oculta, `chooseRoot()` la quita. Se subió un ZIP con `.git/config` y `.git/HEAD`. El servidor informó `root = .git`, `skipped = []`, y `/s/audit-hidden/config` devolvió `200` con el contenido original. El bloqueo de dotfiles al servir ya no ayuda porque el nombre almacenado es `config`.

Excluir las rutas ocultas y las carpetas prohibidas en la validación del servidor antes de elegir la raíz, medir y extraer. No quitar una carpeta de raíz que se debería rechazar. Verificar que la lista de descartados refleje lo ocurrido y que panel y API apliquen la misma política.

### S13. Las dependencias necesitan una revisión de actualizaciones

Referencias: `pnpm-lock.yaml:1386`, `gh-pages/package.json` y `gh-pages/next.config.mjs`.

El lockfile de la aplicación fija `devalue 5.9.0`. Se usa en el SSR compilado de SvelteKit, aunque el inventario del registro lo clasifique en el árbol de desarrollo. Sus avisos incluyen exposición de memoria al serializar un Buffer y problemas de consumo de recursos. Las correcciones de los avisos detectados llegan a `5.9.3`. Véanse los avisos del mantenedor sobre [memoria compartida](https://github.com/sveltejs/devalue/security/advisories/GHSA-j22f-vq7h-c4qm) y [entrada malformada](https://github.com/sveltejs/devalue/security/advisories/GHSA-9rgm-9g3h-6x36).

No he encontrado un `load` de PageBox que devuelva un Buffer ni demostrado una petición que explote esos avisos. Actualizar sigue siendo razonable antes de publicar, pero no hay evidencia para anunciar una fuga de memoria de PageBox ya reproducida.

También aparecen `cookie 0.6.0`, `esbuild 0.18.20` en herramientas de Drizzle, y `vitest / @vitest/mocker 4.1.10`. El aviso de Vitest se corrige desde `4.1.11`. La exposición de un servidor de desarrollo es distinta de la del servidor construido para producción.

El proyecto de documentación fija `next 16.3.2`, con tres avisos críticos. El más reciente de los detectados se corrige desde `16.3.6`, según el [aviso de ImageResponse](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j). Los otros afectan al [servidor alojado sobre Windows](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) y a la [optimización de imágenes AVIF](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4). Aquí se publica una exportación estática, con imágenes sin optimizador. Eso no expone un servidor Next ni esos endpoints en GitHub Pages o PageBox. Sí conviene actualizar las herramientas de generación y revisar los otros avisos del lockfile de docs.

Actualizar las versiones y el lockfile de forma controlada, construir y ejecutar ambas suites. Usar los resultados de auditoría como inventario, comprobando qué código llega al runtime. No aplicar un `audit fix --force` sin revisar sus cambios.

### S14. La excepción Bearer se aplica fuera de la API y sin validación

Referencia: `src/hooks.server.ts:145`.

`sameOriginMutation()` devuelve `true` cuando cualquier petición lleva una cabecera que empieza por `Bearer `. La excepción se aplica también a acciones del panel que ignoran ese token y usan la cookie.

Una acción para deshabilitar un sitio, con cookie válida y `Origin: https://untrusted.example`, recibió `403`. Con `Authorization: Bearer meaningless-value`, la misma acción recibió `success` y deshabilitó el sitio.

Eso demuestra un defecto de validación, pero no por sí solo un ataque desde una web externa: añadir Authorization en ese contexto requiere un preflight CORS que no se ha demostrado que PageBox acepte. Por eso no se clasifica como explotación externa confirmada.

Limitar la excepción a endpoints de API que seleccionen exclusivamente autenticación Bearer y rechacen un token inválido sin volver a la cookie. Para acciones del panel, exigir siempre el origen autorizado. Comparar con el origen público configurado completo permite conservar protocolo y puerto sin depender del protocolo interno que ve el servidor. La confianza actual por hostname permite también otros orígenes del mismo host en distintos puertos.

### S15. Las rutas percent-encoded no se convierten al nombre del objeto

Referencias: `src/lib/server/sites/resolve.ts:54` y `src/lib/server/sites/serve.ts:57`.

Los ZIP aceptan `hello world.txt` y `café.txt`. El navegador pide `hello%20world.txt` y `caf%C3%A9.txt`, pero el código mantiene el pathname codificado y construye claves S3 distintas de las almacenadas. Ambos archivos respondieron `404` después de una subida correcta.

Decodificar una sola vez, por segmentos, y volver a validar separadores, traversal y dotfiles antes de formar la clave. Rechazar codificación malformada. La corrección debe incluir pruebas de espacios y Unicode, además de `%2f`, `%5c`, `%2e` y doble codificación, para que solucionar el fallo funcional no abra un fallo de acceso.

## Observaciones de diseño y cobertura

Estos puntos se detectaron por revisión y no se cuentan como ataques reproducidos:

- `listEntryPaths()` y `measureZip()` recorren y materializan el directorio del ZIP antes de aplicar `MAX_FILES` durante la extracción. Limitar entradas y longitudes desde la primera lectura reduce el coste de archivos hostiles. Falta también un límite global de subidas en curso y espacio temporal; la cuota de S3 no reserva el disco usado por los ZIP en espera.
- La redirección de `/s/<slug>` a su barra final ocurre antes de comprobar sesión, permisos o suspensión y no lleva la política de caché privada. Un usuario sin grant puede obtener una respuesta distinta de la de un slug inexistente. La redirección debería quedar después de esas comprobaciones.
- La ausencia de un solo hermano `.br` desactiva las búsquedas de Brotli para todo el despliegue durante cinco minutos. Una distribución con precompresión parcial pierde la compresión según qué archivo se pidió primero. `Vary: Accept-Encoding` debe reflejar todas las respuestas negociables.
- La autorización se comprueba antes de una subida que puede durar bastante. Si se revoca un token, se suspende una cuenta o se retira un grant durante esa subida, no se revalida antes de activar. Conviene definir la garantía de revocación para operaciones en curso y comprobarla al publicar.
- La prueba de cookies en `tests/integration/hardening.test.ts:38` intenta iniciar sesión con un usuario inexistente y comprueba únicamente las cookies devueltas. Si no se emite ninguna, pasa sin demostrar que una cookie de sesión real sea host-only. La prueba de symlinks retorna sin comprobar el rechazo cuando falta `PAGEBOX_E2E_TOKEN`; el workflow no lo proporciona. Estas pruebas verdes dan menos cobertura de la que sugieren sus nombres.
- `scripts/seed-demo.mjs` transfiere la plaza de superadmin al usuario de pruebas. Se ejecutó exclusivamente en la base aislada. Ese comportamiento debe seguir siendo explícito y no usarse para verificar una instancia real con datos.

La separación entre panel y sitios, el scope de sesión, la ausencia de registro público, la comprobación de permisos sobre cada archivo, el almacenamiento de tokens con hash, los límites de extracción y las consultas parametrizadas son decisiones útiles. Los problemas principales aparecen en transiciones y límites compartidos: promoción, reset, revocación, publicación concurrente y caché. Hay que probar esos cambios de estado además de los casos estables.

## Orden de corrección propuesto

1. Corregir S02, S03 y S04. Son cambios acotados de autorización y revocación, con reproducciones claras.
2. Resolver S01 antes de aceptar contenido de autores independientes. Requiere decidir el modelo de origen y sesión por sitio.
3. Corregir S05, S06 y S07 para que concurrencia o fallos parciales no bloqueen la instancia ni dejen datos huérfanos.
4. Corregir invalidación de permisos, cuotas y extracción de carpetas ocultas. Añadir a integración las transiciones reproducidas.
5. Revisar la exposición real de puertos y la cadena del proxy. Actualizar los lockfiles y verificar la imagen que se vaya a publicar.

Para cerrar la evaluación del homelab queda comprobar su configuración efectiva: qué puertos son accesibles desde fuera, qué proxy reemplaza cada cabecera, cómo se protege el bucket y qué versión exacta de la imagen está desplegada. Esas condiciones no se pueden deducir del repositorio.
