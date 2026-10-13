import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createProxy, request as proxyRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

const mark = randomUUID().slice(0, 8);
const containers = [];
let server;
let proxy;
let temporaryRoot;
let log = '';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const portOf = (name, port) => docker('port', name, `${port}/tcp`).split(':').at(-1);

async function run(command, args, env) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: 'inherit' });
		child.on('error', reject);
		child.on('exit', (code) =>
			code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))
		);
	});
}

try {
	temporaryRoot = await mkdtemp(join(tmpdir(), `pagebox-test-${mark}-`));
	const pgName = `pagebox-test-${mark}-pg`;
	containers.push(
		docker(
			'run',
			'-d',
			'--rm',
			'--name',
			pgName,
			'-p',
			'127.0.0.1::5432',
			'-e',
			'POSTGRES_USER=fixture',
			'-e',
			'POSTGRES_PASSWORD=fixture-local-password',
			'-e',
			'POSTGRES_DB=fixture',
			'postgres:16-alpine'
		)
	);
	const s3Name = `pagebox-test-${mark}-s3`;
	containers.push(
		docker(
			'run',
			'-d',
			'--rm',
			'--name',
			s3Name,
			'-p',
			'127.0.0.1::9000',
			'-e',
			'MINIO_ROOT_USER=fixture-local',
			'-e',
			'MINIO_ROOT_PASSWORD=fixture-local-secret',
			'pgsty/minio:RELEASE.2026-08-04T00-00-00Z',
			'server',
			'/data'
		)
	);
	const database = `postgres://fixture:fixture-local-password@127.0.0.1:${portOf(pgName, 5432)}/fixture`;
	const endpoint = `http://127.0.0.1:${portOf(s3Name, 9000)}`;
	const probe = createServer();
	await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
	const port = probe.address().port;
	await new Promise((resolve) => probe.close(resolve));
	const backendProbe = createServer();
	await new Promise((resolve) => backendProbe.listen(0, '127.0.0.1', resolve));
	const backendPort = backendProbe.address().port;
	await new Promise((resolve) => backendProbe.close(resolve));
	proxy = createProxy((incoming, outgoing) => {
		const upstream = proxyRequest(
			{
				hostname: '127.0.0.1',
				port: backendPort,
				path: incoming.url,
				method: incoming.method,
				headers: {
					...incoming.headers,
					'x-forwarded-host': incoming.headers['x-forwarded-host'] ?? incoming.headers.host,
					'x-forwarded-proto': 'http',
					'x-forwarded-for': incoming.headers['x-forwarded-for'] ?? incoming.socket.remoteAddress
				}
			},
			(response) => {
				outgoing.writeHead(response.statusCode, response.headers);
				response.pipe(outgoing);
			}
		);
		upstream.on('error', () => {
			if (!outgoing.headersSent) {
				outgoing.writeHead(502);
				outgoing.end();
			} else outgoing.destroy();
		});
		outgoing.on('close', () => upstream.destroy());
		incoming.pipe(upstream);
	});
	await new Promise((resolve) => proxy.listen(port, '127.0.0.1', resolve));
	const env = {
		...process.env,
		NODE_ENV: 'production',
		PORT: String(backendPort),
		HOST: '127.0.0.1',
		DATABASE_URL: database,
		DATABASE_URL_HOST: database,
		DATABASE_POOL_MAX: process.env.PAGEBOX_TEST_POOL_MAX ?? '1',
		S3_ENDPOINT: endpoint,
		S3_ENDPOINT_HOST: endpoint,
		S3_ACCESS_KEY: 'fixture-local',
		S3_SECRET_KEY: 'fixture-local-secret',
		S3_BUCKET: 'fixture',
		PAGEBOX_ADMIN_HOST: `pagebox.localhost:${port}`,
		PAGEBOX_SITES_HOST: `pages.localhost:${port}`,
		PAGEBOX_PUBLIC_SCHEME: 'http',
		PAGEBOX_REPLICAS: '1',
		AUTH_SECRET: randomUUID() + randomUUID(),
		BOOTSTRAP_ADMIN_EMAIL: 'fixture-bootstrap@example.com',
		BOOTSTRAP_ADMIN_PASSWORD: 'fixture-bootstrap-password',
		PAGEBOX_E2E_BASE: `http://127.0.0.1:${port}`,
		PAGEBOX_E2E_EMAIL: 'e2e-admin@example.com',
		PAGEBOX_E2E_PASSWORD: 'fixture-chosen-password',
		PAGEBOX_E2E_ADMIN_HOST: `pagebox.localhost:${port}`,
		PAGEBOX_E2E_SITES_HOST: `pages.localhost:${port}`,
		PAGEBOX_STORAGE_BYTES: '500GB',
		PAGEBOX_DEFAULT_QUOTA_BYTES: '5GB',
		LOGIN_MAX_ATTEMPTS: '200',
		HOST_HEADER: 'x-forwarded-host',
		PROTOCOL_HEADER: 'x-forwarded-proto',
		ADDRESS_HEADER: 'x-forwarded-for',
		XFF_DEPTH: '1',
		BODY_SIZE_LIMIT: '104857600',
		MAX_UPLOAD_BYTES: '100MB',
		MAX_UNCOMPRESSED_BYTES: '500MB',
		MAX_FILES: '20000',
		UPLOAD_BODY_TIMEOUT_SECONDS: '10',
		PAGEBOX_MIGRATE_ON_START: 'true',
		PAGEBOX_ENSURE_BUCKET_ON_START: 'true',
		PAGEBOX_DB_TESTS: '1'
	};
	env.PAGEBOX_TMP_DIR = temporaryRoot;
	delete env.REDIS_URL;
	delete env.PAGEBOX_E2E_TOKEN;
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			if ((await fetch(`${endpoint}/minio/health/live`)).ok) break;
		} catch {
			/* Service is still starting. */
		}
		await delay(500);
	}
	server = spawn(process.execPath, ['build/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	server.stdout.on('data', (chunk) => {
		log += chunk;
	});
	server.stderr.on('data', (chunk) => {
		log += chunk;
	});
	let healthy = false;
	for (let attempt = 0; attempt < 90; attempt++) {
		if (server.exitCode !== null) throw new Error('Server exited during startup');
		try {
			healthy = (await fetch(`${env.PAGEBOX_E2E_BASE}/healthz`)).ok;
		} catch {
			/* Not listening yet. */
		}
		if (healthy) break;
		await delay(500);
	}
	if (!healthy) throw new Error('Server did not become healthy');
	await run(process.execPath, ['scripts/seed-demo.mjs'], env);
	const files = process.argv.slice(2);
	await run(
		process.execPath,
		['node_modules/vitest/vitest.mjs', 'run', ...(files.length ? files : ['tests/integration'])],
		env
	);
} catch (error) {
	console.error(error);
	console.error(
		log.length > 9000 ? `${log.slice(0, 3000)}\n[log truncated]\n${log.slice(-6000)}` : log
	);
	process.exitCode = 1;
} finally {
	proxy?.closeAllConnections();
	if (proxy) await new Promise((resolve) => proxy.close(resolve));
	if (server && server.exitCode === null) {
		server.kill();
		await Promise.race([new Promise((resolve) => server.on('exit', resolve)), delay(6000)]);
		if (server.exitCode === null) server.kill('SIGKILL');
	}
	for (const container of containers.reverse()) {
		try {
			docker('stop', container);
		} catch (error) {
			console.error('Cleanup failed:', error.message);
			process.exitCode = 1;
		}
	}
	if (temporaryRoot) {
		const target = resolve(temporaryRoot);
		if (
			dirname(target) !== resolve(tmpdir()) ||
			!basename(target).startsWith(`pagebox-test-${mark}-`)
		)
			throw new Error('Unexpected fixture temporary directory');
		await rm(target, { recursive: true, force: true });
	}
}
