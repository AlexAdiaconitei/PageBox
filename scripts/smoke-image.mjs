import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';

const image = process.argv[2];
const expectedVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
if (!image) throw new Error('Usage: node scripts/smoke-image.mjs <local-image>');
const mark = `pagebox-smoke-${randomUUID().slice(0, 8)}`;
const docker = (...args) => {
	const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
};
const containers = [];
try {
	docker('network', 'create', mark);
	for (const [suffix, env, args] of [
		[
			'pg',
			['POSTGRES_USER=fixture', 'POSTGRES_PASSWORD=fixture-local-password', 'POSTGRES_DB=fixture'],
			['postgres:16-alpine']
		],
		[
			's3',
			['MINIO_ROOT_USER=fixture-storage', 'MINIO_ROOT_PASSWORD=fixture-storage-password'],
			['minio/minio:latest', 'server', '/data']
		]
	]) {
		const name = `${mark}-${suffix}`;
		containers.push(name);
		docker(
			'run',
			'-d',
			'--rm',
			'--name',
			name,
			'--network',
			mark,
			...env.flatMap((value) => ['-e', value]),
			...args
		);
	}
	const app = `${mark}-app`;
	containers.push(app);
	const env = {
		PAGEBOX_ADMIN_HOST: 'panel.fixture.test',
		PAGEBOX_SITES_HOST: 'reader.fixture.test',
		PAGEBOX_PUBLIC_SCHEME: 'http',
		DATABASE_URL: `postgres://fixture:fixture-local-password@${mark}-pg:5432/fixture`,
		DATABASE_POOL_MAX: '1',
		S3_ENDPOINT: `http://${mark}-s3:9000`,
		S3_ACCESS_KEY: 'fixture-storage',
		S3_SECRET_KEY: 'fixture-storage-password',
		S3_BUCKET: 'fixture',
		AUTH_SECRET: randomUUID() + randomUUID(),
		BOOTSTRAP_ADMIN_EMAIL: 'fixture@example.com',
		BOOTSTRAP_ADMIN_PASSWORD: 'fixture-bootstrap-password',
		PAGEBOX_ENSURE_BUCKET_ON_START: 'true',
		MAX_UPLOAD_BYTES: '150MB'
	};
	docker(
		'run',
		'-d',
		'--rm',
		'--name',
		app,
		'--network',
		mark,
		'-p',
		'127.0.0.1::3000',
		'--cap-drop=ALL',
		'--security-opt=no-new-privileges:true',
		...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
		image
	);
	const port = docker('port', app, '3000/tcp').split(':').at(-1);
	let healthy = false;
	for (let i = 0; i < 60; i++) {
		try {
			healthy = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
		} catch {}
		if (healthy) break;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.ok(healthy, docker('logs', app));
	for (const [host, path, expected] of [
		['panel.fixture.test', '/', 303],
		['reader.fixture.test', '/login', 200],
		['unknown.fixture.test', '/', 404]
	]) {
		const status = await new Promise((resolve, reject) => {
			request(`http://127.0.0.1:${port}${path}`, { headers: { host } }, (response) => {
				response.resume();
				response.on('end', () => resolve(response.statusCode));
			})
				.on('error', reject)
				.end();
		});
		assert.equal(status, expected, `${host}${path}`);
	}
	const inspect = JSON.parse(docker('inspect', app))[0];
	assert.equal(inspect.Config.User, 'app');
	assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL']);
	assert.ok(docker('logs', app).includes('upload-cap=150 MB'));
	assert.equal(
		docker(
			'exec',
			app,
			'node',
			'--input-type=module',
			'-e',
			'import { readFile } from "node:fs/promises"; console.log(JSON.parse(await readFile("package.json", "utf8")).version)'
		),
		expectedVersion
	);
	console.log(
		`Docker smoke passed: migrations, bootstrap, host routing, non-root runtime, upload units, version ${expectedVersion}.`
	);
} finally {
	for (const name of containers.reverse()) docker('rm', '-f', name);
	docker('network', 'rm', mark);
}
