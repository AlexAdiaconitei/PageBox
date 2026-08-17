import { describe, expect, it } from 'vitest';
import { parseConfig, formatBytes } from '../../src/lib/server/config';

const base = {
	PAGEBOX_ADMIN_HOST: 'pagebox.example.com',
	PAGEBOX_SITES_HOST: 'pages.example.com',
	DATABASE_URL: 'postgres://u:p@localhost:5432/db',
	S3_ENDPOINT: 'http://localhost:9000',
	S3_ACCESS_KEY: 'key',
	S3_SECRET_KEY: 'secret',
	AUTH_SECRET: 'a'.repeat(32)
};

describe('config', () => {
	it('accepts a minimal valid environment', () => {
		const { config, errors } = parseConfig(base);
		expect(errors).toEqual([]);
		expect(config?.PAGEBOX_SITES_PREFIX).toBe('/s');
		expect(config?.PAGEBOX_REPLICAS).toBe(1);
	});

	// The host split is the security boundary of the whole design (PLAN §D1).
	it('refuses identical admin and sites hosts', () => {
		const { config, errors } = parseConfig({ ...base, PAGEBOX_SITES_HOST: 'pagebox.example.com' });
		expect(config).toBeUndefined();
		expect(errors.join(' ')).toMatch(/must be different hostnames/);
	});

	it('compares hosts case-insensitively', () => {
		const { config } = parseConfig({ ...base, PAGEBOX_SITES_HOST: 'PAGEBOX.example.com' });
		expect(config).toBeUndefined();
	});

	it('defaults the upload cap to 100 MB and keeps it configurable', () => {
		expect(parseConfig(base).config?.MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);

		const raised = parseConfig({
			...base,
			MAX_UPLOAD_BYTES: String(400 * 1024 * 1024)
		});
		expect(raised.errors).toEqual([]);
		expect(raised.config?.MAX_UPLOAD_BYTES).toBe(400 * 1024 * 1024);
		expect(raised.config?.maxUploadLabel).toBe('400 MB');
	});

	it('refuses an upload cap above the uncompressed cap', () => {
		const { errors } = parseConfig({
			...base,
			MAX_UPLOAD_BYTES: String(600 * 1024 * 1024)
		});
		expect(errors.join(' ')).toMatch(/cannot exceed MAX_UNCOMPRESSED_BYTES/);
	});

	it('requires a shared cache for more than one replica', () => {
		expect(parseConfig({ ...base, PAGEBOX_REPLICAS: '2' }).errors.join(' ')).toMatch(/REDIS_URL/);
		expect(
			parseConfig({ ...base, PAGEBOX_REPLICAS: '2', REDIS_URL: 'redis://valkey:6379' }).errors
		).toEqual([]);
	});

	it('requires a long AUTH_SECRET', () => {
		expect(parseConfig({ ...base, AUTH_SECRET: 'short' }).errors.join(' ')).toMatch(/AUTH_SECRET/);
	});

	it('requires bootstrap email and password together', () => {
		expect(parseConfig({ ...base, BOOTSTRAP_ADMIN_EMAIL: 'a@b.com' }).errors.join(' ')).toMatch(
			/must be set together/
		);
	});

	it('normalises the sites prefix', () => {
		expect(
			parseConfig({ ...base, PAGEBOX_SITES_PREFIX: 'sites/' }).config?.PAGEBOX_SITES_PREFIX
		).toBe('/sites');
	});

	it('formats byte labels', () => {
		expect(formatBytes(104857600)).toBe('100 MB');
		expect(formatBytes(1536)).toBe('1.5 KB');
	});
});
