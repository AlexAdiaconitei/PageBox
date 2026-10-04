import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const binary = process.env.PAGEBOX_COMPOSE_BINARY ?? 'docker';
const prefix = process.env.PAGEBOX_COMPOSE_BINARY ? [] : ['compose'];
const fixture = 'security-checks/compose-fixture.env';
const nl = String.fromCharCode(10);
const values = Object.fromEntries(
	(await fs.readFile(fixture, 'utf8'))
		.split(nl)
		.filter((line) => line.includes('='))
		.map((line) => {
			const index = line.indexOf('=');
			return [line.slice(0, index), line.slice(index + 1)];
		})
);
const invoke = (file, env = {}, envFile = fixture) =>
	spawnSync(binary, [...prefix, '--env-file', envFile, '-f', file, 'config', '--format', 'json'], {
		encoding: 'utf8',
		windowsHide: true,
		timeout: 15000,
		env: { ...process.env, ...values, ...env }
	});
const checks = [];
for (const file of ['docker-compose.yml', 'docker-compose.dokploy.yml']) {
	const result = invoke(file);
	assert.equal(result.status, 0, result.stderr);
	const config = JSON.parse(result.stdout);
	const app = config.services[file === 'docker-compose.yml' ? 'app' : 'pagebox'];
	assert.equal('MINIO_ROOT_USER' in app.environment, false);
	assert.equal('MINIO_ROOT_PASSWORD' in app.environment, false);
	assert.equal('POSTGRES_PASSWORD' in app.environment, false);
	assert.equal(app.environment.S3_ACCESS_KEY, values.S3_ACCESS_KEY);
	assert.equal(app.environment.PAGEBOX_ENSURE_BUCKET_ON_START, 'false');
	for (const name of ['HOST_HEADER', 'PROTOCOL_HEADER', 'ADDRESS_HEADER'])
		assert.equal(app.environment[name] ?? null, null);
	assert.deepEqual(app.cap_drop, ['ALL']);
	assert.deepEqual(app.security_opt, ['no-new-privileges:true']);
	assert.equal(app.environment.BOOTSTRAP_ADMIN_EMAIL, values.BOOTSTRAP_ADMIN_EMAIL);
	if (file === 'docker-compose.yml') {
		for (const name of ['app', 'postgres', 'minio'])
			for (const port of config.services[name].ports) assert.equal(port.host_ip, '127.0.0.1');
		assert.notEqual(
			app.environment.S3_ACCESS_KEY,
			config.services.minio.environment.MINIO_ROOT_USER
		);
	}
	checks.push({
		file,
		rendered: true,
		appStorageAdminExcluded: true,
		bootstrapPassed: true,
		implicitProxyTrust: false
	});
	const proxyHeaders = {
		HOST_HEADER: 'x-forwarded-host',
		PROTOCOL_HEADER: 'x-forwarded-proto',
		ADDRESS_HEADER: 'x-forwarded-for',
		XFF_DEPTH: '2'
	};
	const proxy = invoke(file, proxyHeaders);
	assert.equal(proxy.status, 0, proxy.stderr);
	const proxyApp = JSON.parse(proxy.stdout).services[
		file === 'docker-compose.yml' ? 'app' : 'pagebox'
	];
	for (const [name, value] of Object.entries(proxyHeaders))
		assert.equal(proxyApp.environment[name], value);
	checks.push({ file, explicitProxyConfiguration: true });
}
for (const name of [
	'PAGEBOX_TAG',
	'PAGEBOX_ADMIN_HOST',
	'PAGEBOX_SITES_HOST',
	'POSTGRES_PASSWORD',
	'MINIO_ROOT_USER',
	'MINIO_ROOT_PASSWORD',
	'S3_ACCESS_KEY',
	'S3_SECRET_KEY',
	'AUTH_SECRET'
]) {
	const result = invoke('docker-compose.yml', { [name]: '' });
	assert.notEqual(result.status, 0, 'Missing ' + name + ' must stop Compose');
	assert.ok(result.stderr.includes(name), result.stderr);
	checks.push({ missing: name, rejected: true });
}
const noBootstrapFile = 'security-checks/compose-no-bootstrap.env';
const noBootstrap = Object.entries(values).filter(([key]) => !key.startsWith('BOOTSTRAP_ADMIN_'));
await fs.writeFile(
	noBootstrapFile,
	noBootstrap.map(([key, value]) => key + '=' + value).join(nl) + nl
);
const noBootstrapEnv = { ...process.env, ...Object.fromEntries(noBootstrap) };
delete noBootstrapEnv.BOOTSTRAP_ADMIN_EMAIL;
delete noBootstrapEnv.BOOTSTRAP_ADMIN_PASSWORD;
const noBootstrapResult = spawnSync(
	binary,
	[
		...prefix,
		'--env-file',
		noBootstrapFile,
		'-f',
		'docker-compose.yml',
		'config',
		'--format',
		'json'
	],
	{
		encoding: 'utf8',
		windowsHide: true,
		timeout: 15000,
		env: noBootstrapEnv
	}
);
assert.equal(noBootstrapResult.status, 0, noBootstrapResult.stderr);
const noBootstrapConfig = JSON.parse(noBootstrapResult.stdout);
assert.equal(noBootstrapConfig.services.app.environment.BOOTSTRAP_ADMIN_EMAIL, null);
assert.equal(noBootstrapConfig.services.app.environment.BOOTSTRAP_ADMIN_PASSWORD, null);
checks.push({ bootstrapOmitted: true });
const report = {
	checkedAt: new Date().toISOString(),
	checks,
	startsContainers: false,
	traefikRuntimeTested: false,
	usesFixtureCredentials: true
};
await fs.writeFile('security-checks/compose-results.json', JSON.stringify(report, null, 2) + nl);
console.log(JSON.stringify({ passed: checks.length, containersStarted: false }));
