import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

let databaseConnections = 0;
let storageRequests = 0;
const database = net.createServer((socket) => {
	databaseConnections++;
	socket.destroy();
});
const storage = http.createServer((request, response) => {
	storageRequests++;
	response.writeHead(500).end();
});
await Promise.all([
	new Promise((resolve) => database.listen(0, '127.0.0.1', resolve)),
	new Promise((resolve) => storage.listen(0, '127.0.0.1', resolve))
]);
const baseline = {
	...process.env,
	PAGEBOX_DB_TESTS: '0',
	PAGEBOX_E2E_EMAIL: 'script-fixture@example.test',
	PAGEBOX_E2E_PASSWORD: 'script-fixture-password',
	DATABASE_URL: `postgres://fixture:fixture@127.0.0.1:${database.address().port}/fixture`,
	DATABASE_URL_HOST: '',
	S3_ENDPOINT: `http://127.0.0.1:${storage.address().port}`,
	S3_ENDPOINT_HOST: '',
	S3_ACCESS_KEY: 'script-fixture',
	S3_SECRET_KEY: 'script-fixture-password'
};
delete baseline.DATABASE_URL_HOST;
delete baseline.S3_ENDPOINT_HOST;
const cases = [
	{
		name: 'seed requires a disposable database',
		script: 'seed-demo',
		args: [],
		expected: 'Refusing to seed'
	},
	{
		name: 'seed flag requires explicit email',
		script: 'seed-demo',
		args: ['--disposable'],
		env: { PAGEBOX_E2E_EMAIL: '' },
		expected: 'Explicit PAGEBOX_E2E'
	},
	{
		name: 'test database requires explicit password',
		script: 'seed-demo',
		args: [],
		env: { PAGEBOX_DB_TESTS: '1', PAGEBOX_E2E_PASSWORD: '' },
		expected: 'Explicit PAGEBOX_E2E'
	},
	{
		name: 'seed rejects short passwords',
		script: 'seed-demo',
		args: ['--disposable'],
		env: { PAGEBOX_E2E_PASSWORD: 'short' },
		expected: 'between 10 and 200'
	},
	{
		name: 'seed rejects excessive passwords',
		script: 'seed-demo',
		args: ['--disposable'],
		env: { PAGEBOX_E2E_PASSWORD: 'x'.repeat(201) },
		expected: 'between 10 and 200'
	},
	{
		name: 'seed rejects missing database URL',
		script: 'seed-demo',
		args: ['--disposable'],
		env: { DATABASE_URL: '' },
		expected: 'DATABASE_URL must be'
	},
	{
		name: 'seed rejects non-Postgres URL',
		script: 'seed-demo',
		args: ['--disposable'],
		env: { DATABASE_URL: 'https://example.test/' },
		expected: 'DATABASE_URL must be'
	},
	{
		name: 'seed rejects non-HTTP storage URL',
		script: 'seed-demo',
		args: ['--disposable'],
		env: { S3_ENDPOINT: 'file:///tmp/fixture' },
		expected: 'S3_ENDPOINT must be'
	},
	{
		name: 'seed rejects absent storage credentials',
		script: 'seed-demo',
		args: ['--disposable'],
		env: { S3_SECRET_KEY: '' },
		expected: 'S3_ACCESS_KEY and S3_SECRET_KEY'
	},
	{
		name: 'seed rejects traversal slug',
		script: 'seed-demo',
		args: ['--disposable', '--slug', '../fixture'],
		expected: 'slug and fixture suffixes'
	},
	{
		name: 'seed suffixes must fit maximum slug length',
		script: 'seed-demo',
		args: ['--disposable', '--slug', 'x'.repeat(40)],
		expected: 'slug and fixture suffixes'
	},
	{
		name: 'recovery requires an email',
		script: 'set-password',
		args: ['--password', 'fixture-password'],
		expected: '--email is required'
	},
	{
		name: 'recovery requires a password',
		script: 'set-password',
		args: ['--email', 'fixture@example.test'],
		expected: '--password is required'
	},
	{
		name: 'recovery rejects short passwords',
		script: 'set-password',
		args: ['--email', 'fixture@example.test', '--password', 'short'],
		expected: 'between 10 and 200'
	},
	{
		name: 'recovery rejects excessive passwords',
		script: 'set-password',
		args: ['--email', 'fixture@example.test', '--password', 'x'.repeat(201)],
		expected: 'between 10 and 200'
	},
	{
		name: 'recovery rejects a flag as password',
		script: 'set-password',
		args: ['--email', 'fixture@example.test', '--password', '--keep'],
		expected: '--password is required'
	},
	{
		name: 'recovery rejects invalid database protocol',
		script: 'set-password',
		args: ['--email', 'fixture@example.test', '--password', 'fixture-password'],
		env: { DATABASE_URL: 'https://example.test/' },
		expected: 'DATABASE_URL must be'
	}
];
const run = (item) =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['scripts/' + item.script + '.mjs', ...item.args], {
			env: { ...baseline, ...item.env },
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '',
			stderr = '';
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(item.name + ' timed out'));
		}, 10000);
		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
try {
	for (const item of cases) {
		const result = await run(item);
		assert.equal(result.code, 1, item.name + ': ' + result.stderr);
		assert.ok(result.stderr.includes(item.expected), item.name + ': ' + result.stderr);
		assert.equal(databaseConnections, 0, item.name + ': touched the database');
		assert.equal(storageRequests, 0, item.name + ': touched storage');
	}
	await fs.writeFile(
		'security-checks/script-results.json',
		JSON.stringify(
			{
				checkedAt: new Date().toISOString(),
				passed: cases.length,
				cases: cases.map((item) => item.name),
				databaseConnections,
				storageRequests,
				databaseTransactionsTested: false
			},
			null,
			2
		) + '\n'
	);
	console.log(JSON.stringify({ passed: cases.length, databaseConnections, storageRequests }));
} finally {
	await Promise.all([
		new Promise((resolve) => database.close(resolve)),
		new Promise((resolve) => storage.close(resolve))
	]);
}
