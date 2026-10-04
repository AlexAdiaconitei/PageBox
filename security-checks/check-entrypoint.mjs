import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const shell =
	process.env.PAGEBOX_TEST_SHELL ??
	(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const toShell = (value) =>
	value
		.replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase())
		.replaceAll(String.fromCharCode(92), '/');
const baseline = {
	...process.env,
	PATH: toShell(process.cwd()) + '/security-checks/entrypoint-bin:/usr/bin:/bin'
};
for (const key of [
	'MAX_UPLOAD_BYTES',
	'BODY_SIZE_LIMIT',
	'HOST_HEADER',
	'PROTOCOL_HEADER',
	'ADDRESS_HEADER',
	'XFF_DEPTH',
	'ORIGIN'
])
	delete baseline[key];
const cases = [
	{
		name: 'socket address and real Host by default',
		env: {},
		expected: {
			BODY_SIZE_LIMIT: '104857600',
			HOST_HEADER: 'host',
			PROTOCOL_HEADER: '<unset>',
			ADDRESS_HEADER: '<unset>',
			XFF_DEPTH: '1'
		}
	},
	{
		name: 'explicit trusted proxy',
		env: {
			HOST_HEADER: 'x-forwarded-host',
			PROTOCOL_HEADER: 'x-forwarded-proto',
			ADDRESS_HEADER: 'x-forwarded-for',
			XFF_DEPTH: '2'
		},
		expected: {
			HOST_HEADER: 'x-forwarded-host',
			PROTOCOL_HEADER: 'x-forwarded-proto',
			ADDRESS_HEADER: 'x-forwarded-for',
			XFF_DEPTH: '2'
		}
	},
	{
		name: 'empty headers do not enable proxy trust',
		env: { HOST_HEADER: '', PROTOCOL_HEADER: '', ADDRESS_HEADER: '' },
		expected: { HOST_HEADER: 'host', PROTOCOL_HEADER: '<unset>', ADDRESS_HEADER: '<unset>' }
	},
	{
		name: 'size units preserve the body limit',
		env: { MAX_UPLOAD_BYTES: '1.5GB' },
		expected: { BODY_SIZE_LIMIT: '1610612736' }
	},
	{
		name: 'explicit body limit remains supported',
		env: { MAX_UPLOAD_BYTES: '1GB', BODY_SIZE_LIMIT: '4096' },
		expected: { BODY_SIZE_LIMIT: '4096' }
	},
	{
		name: 'invalid upload size reaches app validation without guessing a limit',
		env: { MAX_UPLOAD_BYTES: 'bogus' },
		expected: { BODY_SIZE_LIMIT: '<unset>' }
	}
];
for (const item of cases) {
	const result = spawnSync(shell, ['--noprofile', '--norc', 'deploy/entrypoint.sh'], {
		cwd: process.cwd(),
		env: { ...baseline, ...item.env },
		encoding: 'utf8',
		windowsHide: true,
		timeout: 10000
	});
	assert.equal(result.status, 0, result.stderr);
	const actual = Object.fromEntries(
		result.stdout
			.trim()
			.split(String.fromCharCode(10))
			.map((line) => {
				const index = line.indexOf('=');
				return [line.slice(0, index), line.slice(index + 1)];
			})
	);
	for (const [key, value] of Object.entries(item.expected))
		assert.equal(actual[key], value, item.name + ': ' + key);
}
await fs.writeFile(
	'security-checks/entrypoint-results.json',
	JSON.stringify(
		{
			checkedAt: new Date().toISOString(),
			passed: cases.length,
			cases: cases.map((item) => item.name),
			applicationStarted: false,
			nodeReplacedByFixture: true
		},
		null,
		2
	) + String.fromCharCode(10)
);
console.log(JSON.stringify({ passed: cases.length, applicationStarted: false }));
