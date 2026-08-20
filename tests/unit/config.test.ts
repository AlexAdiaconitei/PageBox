import { describe, expect, it } from 'vitest';
import { parseConfig, formatBytes, isPlaceholder } from '../../src/lib/server/config';

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

	// The label used to stop at GB, so a few terabytes of stored builds rendered as
	// "4096.0 GB" — a figure that reads as a bug in the formatter rather than a fleet size.
	it('formats past a gigabyte', () => {
		expect(formatBytes(4 * 1024 ** 4)).toBe('4 TB');
		expect(formatBytes(2.5 * 1024 ** 5)).toBe('2.5 PB');
	});

	/**
	 * The credentials in `.env.example` are the ones people ship, because that is what an
	 * example file is for. They are harmless on a machine nobody else can reach and a
	 * published credential anywhere else, so the boundary is reachability, not NODE_ENV —
	 * the Docker image sets production and the compose stack on a laptop uses that image.
	 */
	describe('placeholder credentials', () => {
		const deployed = {
			...base,
			NODE_ENV: 'production',
			BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
			BOOTSTRAP_ADMIN_PASSWORD: 'a-real-chosen-password',
			AUTH_SECRET: 'k7Qv2sXm9pLdR4wTn8Yc3BhF6jZaG5uE0iNoPrSt1xVy'
		};

		it('accepts real values on a real hostname', () => {
			expect(parseConfig(deployed).errors).toEqual([]);
		});

		it('refuses the example bootstrap password once it is addressable', () => {
			const { errors } = parseConfig({ ...deployed, BOOTSTRAP_ADMIN_PASSWORD: 'change-me-now' });
			expect(errors.join(' ')).toMatch(/BOOTSTRAP_ADMIN_PASSWORD/);
			// Never echoed: an error message is a log line, and that is no place for a secret.
			expect(errors.join(' ')).not.toContain('change-me-now');
		});

		it('refuses the example auth secret once it is addressable', () => {
			const { errors } = parseConfig({
				...deployed,
				AUTH_SECRET: 'change-me-change-me-change-me-change-me'
			});
			expect(errors.join(' ')).toMatch(/AUTH_SECRET/);
		});

		it('catches padding as well as the example strings', () => {
			expect(isPlaceholder('x'.repeat(40))).toBe(true);
			expect(isPlaceholder('CHANGEME')).toBe(true);
			expect(isPlaceholder('  replace-me-please ')).toBe(true);
			expect(isPlaceholder('k7Qv2sXm9pLdR4wTn8Yc3BhF6jZaG5uE')).toBe(false);
		});

		// A laptop running the production image is not a deployment: *.localhost resolves to
		// the loopback address and nowhere else, so the example values stay usable there.
		it('leaves a loopback instance alone', () => {
			const { errors } = parseConfig({
				...deployed,
				PAGEBOX_ADMIN_HOST: 'pagebox.localhost',
				PAGEBOX_SITES_HOST: 'pages.localhost',
				BOOTSTRAP_ADMIN_PASSWORD: 'change-me-now',
				AUTH_SECRET: 'change-me-change-me-change-me-change-me'
			});
			expect(errors).toEqual([]);
		});

		// One real hostname is enough to be reachable — the pair has to be local, not either.
		it('bites when only one host is local', () => {
			const { errors } = parseConfig({
				...deployed,
				PAGEBOX_ADMIN_HOST: 'pagebox.localhost',
				BOOTSTRAP_ADMIN_PASSWORD: 'change-me-now'
			});
			expect(errors.join(' ')).toMatch(/BOOTSTRAP_ADMIN_PASSWORD/);
		});

		// Development is never checked: the value is a convenience there, by design.
		it('says nothing in development', () => {
			const { errors } = parseConfig({
				...deployed,
				NODE_ENV: 'development',
				BOOTSTRAP_ADMIN_PASSWORD: 'change-me-now'
			});
			expect(errors).toEqual([]);
		});
	});
});
