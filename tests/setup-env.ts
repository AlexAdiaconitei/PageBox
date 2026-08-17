/**
 * Minimum valid configuration for unit tests. `src/lib/server/config.ts` parses
 * process.env at import time and exits on anything invalid, which is exactly what we want
 * in production — so tests must provide a valid baseline before importing it.
 */
process.env.NODE_ENV = 'test';
process.env.PAGEBOX_ADMIN_HOST ??= 'pagebox.test';
process.env.PAGEBOX_SITES_HOST ??= 'pages.test';
process.env.DATABASE_URL ??= 'postgres://pagebox:pagebox@localhost:5432/pagebox_test';
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_ACCESS_KEY ??= 'test';
process.env.S3_SECRET_KEY ??= 'testtest';
process.env.AUTH_SECRET ??= 'x'.repeat(48);
