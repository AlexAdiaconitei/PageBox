# Verificación de PageBox 0.2.0

La corrección del código está aplicada y comprobada. La versión sigue sin publicar. No se ha modificado el homelab. Los resultados completos están en [verification.json](verification.json) y los logs de esta carpeta.

| Comprobación | Resultado |
| --- | --- |
| Tipos de la aplicación | 0 errores, 0 avisos de svelte-check |
| Formato | Correcto |
| Pruebas unitarias | 168 correctas |
| Integración | 110 correctas, ninguna fallida; PostgreSQL y MinIO desechables, pool=1 |
| Navegador | Chromium real: login privado, cookies por host y bloqueo de lectura entre sitios |
| Builds | Aplicación e imagen Docker correctas |
| Documentación | Lint, tipos y exportación estática correctos |
| Docker | Migraciones, bootstrap, hosts, usuario sin privilegios y versión comprobados |
| Proxy y almacenamiento | Reglas reales de Traefik y permisos de la clave restringida de MinIO comprobados |
| Configuración y scripts | 14 checks de Compose, 6 del entrypoint y 17 de validación de scripts |
| Recuperación | Reset y rollback ante fallo de auditoría comprobados en PostgreSQL |
| Dependencias de la aplicación | 0 avisos en pnpm audit |
| Dependencias de la documentación | 1 aviso alto sin parche, limitado a lint local |

## Regresiones comprobadas

Los sitios usan un origen con su ID inmutable y cookies host-only ligadas a una sesión padre. Se comprueban cookies centrales rechazadas en los sitios, canje único, replay y canje concurrente, host y puerto incorrectos, expiración, suspensión, retirada de permisos, logout, reset y recreación de slug. La prueba del navegador no simula respuestas: usa el proxy local y los servicios reales.

Las pruebas de almacenamiento cubren conexión del lock, pool de una conexión, operaciones concurrentes, cuotas, activación y borrado, borrados S3 parciales y reintentos. Las de archivo cubren rutas ocultas, symlinks, límites, Unicode, porcentajes y compresión parcial. La subida tiene admisión global, presupuesto temporal y deadlines; se comprueban saturación entre procesos, archivo interrumpido, body detenido y permiso retirado antes de terminarlo.

## Aviso pendiente

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) afecta a braces 3.0.3. No hay versión corregida. En este proyecto lo usa el plugin ESLint de Next para patrones de archivos del repositorio; no se ejecuta en la documentación exportada ni en la imagen de PageBox. No se debe pasar a esa herramienta un patrón no fiable. Queda registrada la excepción y hay que actualizar cuando exista un parche.

## Reproducir

Ejecuta `pnpm check`, `pnpm format:check`, `pnpm vitest run tests/unit` y `pnpm build` desde la raíz. Instala Chromium con `pnpm exec playwright install chromium` y ejecuta `node scripts/test-stack.mjs` para las pruebas HTTP y del navegador. El runner crea servicios y temporales exclusivos para las pruebas y los elimina al terminar.

Ejecuta `pnpm -C gh-pages lint`, `pnpm -C gh-pages build` y `pnpm -C gh-pages types:check` para la documentación. Los scripts `check-router.mjs`, `check-storage-policy.mjs` y `smoke-image.mjs` en scripts verifican el despliegue con contenedores desechables. `verify-final.mjs` comprueba los resultados guardados; no sustituye la ejecución de esas pruebas.

La migración requiere wildcard DNS, rutas del proxy, TLS y revisión o reconstrucción de despliegues antiguos. Sigue [DEPLOYMENT-SECURITY.md](../DEPLOYMENT-SECURITY.md). El DNS público, los certificados y la topología del homelab requieren comprobación al desplegar; no se han cambiado durante este trabajo.
