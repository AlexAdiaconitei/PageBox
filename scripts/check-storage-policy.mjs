import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	DeleteObjectsCommand,
	CreateBucketCommand
} from '@aws-sdk/client-s3';

const mark = `pagebox-policy-${randomUUID().slice(0, 8)}`;
const docker = (...args) => {
	const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
};
const mc = (...args) =>
	docker(
		'run',
		'--rm',
		'--network',
		mark,
		'-e',
		`MC_HOST_fixture=http://fixture-admin:fixture-admin-password@${mark}:9000`,
		'-v',
		`${resolve('storage-policy.example.json')}:/policy.json:ro`,
		'minio/mc:latest',
		...args
	);
try {
	docker('network', 'create', mark);
	docker(
		'run',
		'-d',
		'--rm',
		'--name',
		mark,
		'--network',
		mark,
		'-p',
		'127.0.0.1::9000',
		'-e',
		'MINIO_ROOT_USER=fixture-admin',
		'-e',
		'MINIO_ROOT_PASSWORD=fixture-admin-password',
		'minio/minio:latest',
		'server',
		'/data'
	);
	const endpoint = `http://127.0.0.1:${docker('port', mark, '9000/tcp').split(':').at(-1)}`;
	let healthy = false;
	for (let i = 0; i < 60; i++) {
		try {
			healthy = (await fetch(`${endpoint}/minio/health/live`)).ok;
		} catch {}
		if (healthy) break;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	assert.ok(healthy);
	mc('mb', 'fixture/pagebox');
	mc('mb', 'fixture/forbidden');
	mc('admin', 'user', 'add', 'fixture', 'fixture-app', 'fixture-app-password');
	mc('admin', 'policy', 'create', 'fixture', 'pagebox-app', '/policy.json');
	mc('admin', 'policy', 'attach', 'fixture', 'pagebox-app', '--user', 'fixture-app');
	const app = new S3Client({
		endpoint,
		region: 'us-east-1',
		forcePathStyle: true,
		credentials: { accessKeyId: 'fixture-app', secretAccessKey: 'fixture-app-password' }
	});
	try {
		await app.send(
			new PutObjectCommand({
				Bucket: 'pagebox',
				Key: 'sites/fixture/index.html',
				Body: 'policy-verified'
			})
		);
		const object = await app.send(
			new GetObjectCommand({ Bucket: 'pagebox', Key: 'sites/fixture/index.html' })
		);
		assert.equal(await object.Body.transformToString(), 'policy-verified');
		assert.equal(
			(await app.send(new ListObjectsV2Command({ Bucket: 'pagebox', Prefix: 'sites/' }))).Contents
				.length,
			1
		);
		await assert.rejects(
			app.send(new PutObjectCommand({ Bucket: 'forbidden', Key: 'sites/no', Body: 'no' }))
		);
		await assert.rejects(
			app.send(new PutObjectCommand({ Bucket: 'pagebox', Key: 'outside-sites', Body: 'no' }))
		);
		await assert.rejects(app.send(new CreateBucketCommand({ Bucket: 'forbidden-new' })));
		assert.ok(
			!(
				await app.send(
					new DeleteObjectsCommand({
						Bucket: 'pagebox',
						Delete: { Objects: [{ Key: 'sites/fixture/index.html' }] }
					})
				)
			).Errors?.length
		);
		console.log(
			'Storage policy passed: site read/write/list/delete permitted; other bucket, other prefix and bucket creation denied.'
		);
	} finally {
		app.destroy();
	}
} finally {
	docker('rm', '-f', mark);
	docker('network', 'rm', mark);
}
