# Cierre de la corrección de seguridad

PageBox 0.2.0 está preparado localmente. No se ha publicado, subido al registro ni desplegado en el homelab. Esta revisión cierra el plan sobre el código y las pruebas locales; los requisitos de infraestructura están en [DEPLOYMENT-SECURITY.md](../DEPLOYMENT-SECURITY.md).

## Hallazgos

| Hallazgo | Corrección y comprobación |
| --- | --- |
| S01 | Origen por ID inmutable; código de un solo uso; sesión padre y cookie ligadas al sitio. Chromium confirma el bloqueo entre sitios; HTTP cubre revocación, expiración, canje y recreación de slug. |
| S02 | La administración depende del rol actual de la cuenta. Una promoción impide reset y suspensión por el antiguo emisor. |
| S03 | Reset transaccional del panel y script: revoca sesiones, capacidades derivadas, códigos pendientes y API keys. Se comprueba rollback ante fallo de auditoría. |
| S04 | Cambio obligatorio de contraseña también en la API. |
| S05 | Consultas y transacciones usan la conexión del lock. Pruebas con pool=1 y callbacks concurrentes. |
| S06 | Lock de almacenamiento y FK compuesta protegen el despliegue activo. Activación/borrado concurrentes comprobados. |
| S07 | Los errores por objeto de S3 conservan el estado y los bytes para reintentar la limpieza. |
| S08 | Permisos, grupos y sesiones leídos sin caché de autorización. Retirada de grants y revocación durante el body comprobadas. |
| S09 | Cuotas y cambios de propietario coordinados por el lock. Promoción, transferencia, retención y límites comprobados. |
| S10 | Secretos elegidos, puertos de backend en loopback, clave S3 restringida y proxy explícito. Compose, imagen, Traefik y MinIO comprobados. |
| S11 | Dirección del cliente obtenida del adaptador; cabeceras reenviadas requieren configuración explícita. |
| S12 | Rutas ocultas descartadas antes de elegir raíz; metadatos y extracción acotados. |
| S13 | Actualizadas dependencias vulnerables. Aplicación sin avisos; excepción sin parche de braces en lint local de documentación, descrita debajo. |
| S14 | Origen completo y autenticación Bearer exclusiva en la API. Un Bearer falso no permite usar una cookie ni exime acciones del panel. |
| S15 | Decodificación validada de rutas; Unicode y espacios funcionan; traversal y separadores codificados se rechazan. |

## Observaciones adicionales

- [x] Límite de subidas entre procesos y replicas, reserva de archivos temporales, deadlines y limpieza.
- [x] Autorización antes de redirects privados y antes de activar una subida.
- [x] Miss de compresión por asset y Vary correcto.
- [x] Pruebas de cookies y symlinks autenticadas, con resultados que no pueden pasar sin probar el comportamiento.
- [x] Fixtures exclusivos, credenciales explícitas y seed limitado a datos desechables.
- [x] Versión minor 0.2.0, changelog, documentación y guía de actualización.
- [x] Builds, tipos, formato, pruebas y revisión de dependencias.

## Evidencia

168 pruebas unitarias y 110 de integración correctas. La integración usa PostgreSQL y MinIO desechables, pool=1, un proxy HTTP local y Chromium real. Se comprobaron la imagen Docker, las reglas de Traefik, los permisos de la clave S3, recuperación y rollback, y los ejemplos de configuración. La documentación pasa lint, tipos y build estático. Los comandos y logs están en [security-checks/README.md](../security-checks/README.md).

Queda [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), sin parche publicado, en braces 3.0.3 usado por lint para patrones locales del repositorio. No forma parte de los sitios exportados ni de la imagen de PageBox. La excepción se registra con ese alcance, sin ocultar el aviso del audit.

El despliegue debe comprobar su DNS wildcard, proxy y TLS. Las migraciones no reconstruyen archivos ya almacenados: los despliegues anteriores a ingest version 3 deben revisarse o reconstruirse. No se ha inspeccionado ni modificado el homelab.

## Commits por contexto

- `b2b1f55`: informe y plan.
- `69b51d0`: cuentas, revocación, origen y permisos.
- `542b325`: locks, cuotas y ciclo de vida.
- `b6c451f`: extracción ZIP y rutas.
- `d036ed0`: aislamiento de sitios y migración de sesiones.
- `3e4b93e`: admisión global, temporales y deadlines de subidas.
- `b2b588e`: recuperación transaccional y fixtures.
- `720e7e5`: configuración, proxy y verificaciones de despliegue.
- `91c7a06`: dependencias corregidas y versión 0.2.0.
- `5618af6`: puerto del canje y regresiones de revocación tras reset.
- `1cdbfa2`: smoke de release con fixtures exclusivos y credenciales elegidas.
