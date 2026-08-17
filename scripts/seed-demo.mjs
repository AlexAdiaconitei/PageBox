/**
 * Seeds a deployment by hand, without the upload API (that lands in M2).
 *
 * Creates two sites — one public, one private — uploads a small generated build to S3
 * under a fresh deployment id, and activates it. Enough to exercise every rule in
 * docs/PLAN-static-hosting.md §5 against a real S3 backend.
 *
 *   node scripts/seed-demo.mjs [--slug demo] [--dir path/to/dist]
 *
 * Reads .env, with DATABASE_URL / S3_ENDPOINT overridable from the environment (the
 * compose values point at container hostnames; from the host use localhost ports).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { S3Client, PutObjectCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import postgres from 'postgres';
import { ulid } from 'ulidx';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const env = { ...readEnvFile('.env'), ...process.env };
const DATABASE_URL = env.DATABASE_URL_HOST ?? env.DATABASE_URL.replace('@postgres:', '@127.0.0.1:');
const S3_ENDPOINT = env.S3_ENDPOINT_HOST ?? env.S3_ENDPOINT.replace('//minio:', '//127.0.0.1:');

const slug = argOf('slug', 'demo');
const dir = argOf('dir', null);

const s3 = new S3Client({
	endpoint: S3_ENDPOINT,
	region: env.S3_REGION ?? 'us-east-1',
	forcePathStyle: true,
	credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY }
});
const bucket = env.S3_BUCKET ?? 'pagebox';
const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });

const files = dir ? readBuild(dir) : demoBuild();

await ensureBucket();
await seed(slug, 'public', files);
await seed(`${slug}-private`, 'private', files);
// Separate target for the deploy-API tests, which replace the active deployment and
// would otherwise pull the ground out from under the serving tests.
await seed(`${slug}-api`, 'public', files);
await sql.end();

console.log(`\nseeded ${files.length} files`);
console.log(`  public : ${env.PAGEBOX_SITES_PREFIX ?? '/s'}/${slug}/`);
console.log(`  private: ${env.PAGEBOX_SITES_PREFIX ?? '/s'}/${slug}-private/`);
console.log(`  api     : ${env.PAGEBOX_SITES_PREFIX ?? '/s'}/${slug}-api/   (deploy-API tests)`);

async function seed(siteSlug, visibility, entries) {
	const basePath = `${env.PAGEBOX_SITES_PREFIX ?? '/s'}/${siteSlug}/`;
	const [site] = await sql`
		insert into site (id, slug, name, visibility, base_path, spa_fallback)
		values (${ulid()}, ${siteSlug}, ${siteSlug}, ${visibility}, ${basePath}, false)
		on conflict (slug) do update set visibility = excluded.visibility
		returning id
	`;

	const deploymentId = ulid();
	const total = entries.reduce((sum, e) => sum + e.body.length, 0);
	await sql`
		insert into deployment (id, site_id, status, file_count, total_bytes, source, notes, ready_at)
		values (${deploymentId}, ${site.id}, 'ready', ${entries.length}, ${total}, 'api', 'seed-demo', now())
	`;

	for (const entry of entries) {
		await s3.send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: `sites/${site.id}/${deploymentId}/${entry.path}`,
				Body: entry.body
			})
		);
	}

	await sql`update site set active_deployment_id = ${deploymentId} where id = ${site.id}`;
	console.log(`${siteSlug}: deployment ${deploymentId} active (${entries.length} files)`);
}

async function ensureBucket() {
	try {
		await s3.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch {
		/* already there */
	}
}

/** A build small enough to read, wide enough to hit every resolution rule. */
function demoBuild() {
	const page = (title, body) =>
		Buffer.from(
			`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
				`<link rel="stylesheet" href="style.css"></head><body>${body}</body></html>\n`
		);

	const css = Buffer.from('body{font-family:system-ui;margin:3rem auto;max-width:40rem}\n');

	return [
		{ path: 'index.html', body: page('demo', '<h1>demo root</h1>') },
		{ path: 'about.html', body: page('about', '<h1>about, resolved via .html</h1>') },
		{ path: 'guide/index.html', body: page('guide', '<h1>guide, resolved via index</h1>') },
		{ path: '404.html', body: page('not found', '<h1>custom 404</h1>') },
		{ path: 'style.css', body: css },
		// Precompressed siblings: served when the client accepts them.
		{ path: 'style.css.br', body: brotliCompressSync(css) },
		{ path: 'style.css.gz', body: gzipSync(css) },
		{ path: 'assets/app-4f3a91b2.js', body: Buffer.from('console.log("hashed asset");\n') },
		{ path: 'assets/logo.png', body: Buffer.from('\x89PNG\r\n\x1a\nfake', 'binary') },
		// Must never be served, even though it is in the deployment.
		{ path: '.env', body: Buffer.from('SECRET=should-never-be-served\n') }
	];
}

function readBuild(root) {
	if (!existsSync(root)) throw new Error(`no such directory: ${root}`);
	const out = [];
	const walk = (current) => {
		for (const name of readdirSync(current)) {
			const full = join(current, name);
			if (statSync(full).isDirectory()) walk(full);
			else out.push({ path: relative(root, full).split(sep).join('/'), body: readFileSync(full) });
		}
	};
	walk(root);
	return out;
}

function readEnvFile(path) {
	if (!existsSync(path)) return {};
	const out = {};
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
		if (match) out[match[1]] = match[2];
	}
	return out;
}
