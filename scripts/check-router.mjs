import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { request } from 'node:http';
import assert from 'node:assert/strict';

const mark = `pagebox-router-${randomUUID().slice(0, 8)}`;
const directory = await mkdtemp(join(tmpdir(), mark + '-'));
const docker = (...args) => {
	const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
};
const containers = [];
try {
	docker('network', 'create', mark);
	const config = (await readFile('deploy/traefik-dynamic.example.yml', 'utf8')).replace(
		'http://pagebox-pagebox-1:3000',
		`http://${mark}-backend:80`
	);
	await writeFile(join(directory, 'dynamic.yml'), config);
	containers.push(`${mark}-backend`);
	docker('run', '-d', '--rm', '--network', mark, '--name', `${mark}-backend`, 'nginx:alpine');
	containers.push(mark);
	docker(
		'run',
		'-d',
		'--rm',
		'--network',
		mark,
		'--name',
		mark,
		'-p',
		'127.0.0.1::80',
		'-v',
		`${join(directory, 'dynamic.yml')}:/etc/traefik/dynamic.yml:ro`,
		'traefik:v3.3',
		'--providers.file.filename=/etc/traefik/dynamic.yml',
		'--entrypoints.web.address=:80'
	);
	const port = docker('port', mark, '80/tcp').split(':').at(-1);
	const status = (host) =>
		new Promise((resolve, reject) => {
			request(`http://127.0.0.1:${port}/`, { headers: { host } }, (res) => {
				res.resume();
				res.on('end', () => resolve(res.statusCode));
			})
				.on('error', reject)
				.end();
		});
	let ready = false;
	for (let i = 0; i < 60; i++) {
		try {
			ready = (await status('pagebox.example.com')) === 200;
		} catch {}
		if (ready) break;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.ok(ready, docker('logs', mark));
	for (const [host, expected] of [
		['pages.example.com', 200],
		['demo-01arz3ndektsv4rrffq69g5fav.pages.example.com', 200],
		['demo.pages.example.com', 404],
		['demo-01arz3ndektsv4rrffq69g5fav.pagesXexample.com', 404],
		['demo-01arz3ndektsv4rrffq69g5fav.pages.example.com.evil.test', 404]
	])
		assert.equal(await status(host), expected, host);
	console.log(
		'Traefik router passed: central hosts and immutable site origins matched; near matches rejected.'
	);
} finally {
	for (const container of containers.reverse()) docker('rm', '-f', container);
	docker('network', 'rm', mark);
	const target = resolve(directory);
	if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(mark + '-'))
		throw new Error('Unexpected router fixture directory');
	await rm(target, { recursive: true, force: true });
}
