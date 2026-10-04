# Corrección de la evaluación de seguridad

Objetivo: corregir los quince hallazgos de `SECURITY-REVIEW.md`, comprobar las
transiciones descritas allí y preparar PageBox 0.2.0 sin publicar ni crear un release.

## Grupos de trabajo

- [ ] S02–S04: impedir que el emisor administre cuentas promovidas, revocar sesiones
  y tokens al resetear, exigir el cambio de contraseña también en la API.
- [ ] S08, S11, S14: permisos actuales, dirección del cliente obtenida del adaptador
  y comprobación del origen completo. Bearer solo exime los endpoints de API.
- [ ] S05–S07, S09: usar la conexión que tiene el lock, coordinar cuotas y cambios de
  propietario, proteger activación y borrado, conservar y reintentar borrados parciales.
- [ ] S12, S15: descartar rutas ocultas antes de elegir raíz, acotar la lectura del ZIP
  y decodificar rutas sin aceptar traversal ni separadores codificados.
- [ ] S01: publicar cada sitio en su subdominio, mantener el login en el origen de
  confianza y canjear autorizaciones de un solo uso por sesiones ligadas al sitio.
- [ ] S10, S13: endurecer Compose y secretos, actualizar dependencias vulnerables.
- [ ] Observaciones del informe: presupuesto temporal de subidas, redirects privados,
  compresión parcial, revocación durante subidas y pruebas que antes pasaban sin probar.
- [ ] Versión 0.2.0, changelog e instrucciones de migración.
- [ ] Comprobaciones de tipos, formato, builds, pruebas unitarias e integración,
  regresiones de los hallazgos y revisión de dependencias.

## Diseño del aislamiento

El host configurado en `PAGEBOX_SITES_HOST` aloja únicamente el acceso de lectores.
Cada sitio se publica en `<slug>.<PAGEBOX_SITES_HOST>`. Las rutas `/s/<slug>/`
del host anterior redirigen al subdominio correspondiente. El login central conserva
una cookie host-only y genera un código breve, de un solo uso, para el sitio autorizado.
El subdominio lo canjea por una cookie host-only cuya sesión identifica ese sitio.
Las respuestas privadas comprueban el usuario y sus permisos actuales. Ningún sitio
recibe la cookie central ni una autorización para leer otro sitio.

El cambio requiere DNS wildcard, enrutamiento del proxy y TLS wildcard cuando se usa
HTTPS. Los sitios existentes conservan su ruta base para evitar romper sus assets.
La guía de migración especificará los cambios de infraestructura y reconstrucción.

## Evidencia de cierre

Se registrarán aquí los commits y resultados de las comprobaciones finales.
Las pruebas se ejecutan contra servicios locales con datos desechables. El homelab
no se modifica durante este trabajo.
