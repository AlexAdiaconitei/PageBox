/**
 * Seeds a deployment by hand, without the upload API (that lands in M2).
 *
 * Creates two sites — one public, one private — uploads a small generated build to S3
 * under a fresh deployment id, and activates it. Enough to exercise every rule in
 * docs/PLAN-static-hosting.md §5 against a real S3 backend.
 *
 *   node scripts/seed-demo.mjs --disposable [--slug demo] [--dir path/to/dist]
 *
 * Requires explicit PAGEBOX_E2E_EMAIL and PAGEBOX_E2E_PASSWORD. This script takes the
 * superadmin seat and must only run against disposable databases.
 *
 * Reads .env, with DATABASE_URL / S3_ENDPOINT overridable from the environment (the
 * compose values point at container hostnames; from the host use localhost ports).
 */
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
	S3Client,
	PutObjectCommand,
	CreateBucketCommand,
	HeadBucketCommand
} from '@aws-sdk/client-s3';
import { hashPassword } from 'better-auth/crypto';
import postgres from 'postgres';
import { ulid } from 'ulidx';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const env = { ...readEnvFile('.env'), ...process.env };
if (!args.includes('--disposable') && env.PAGEBOX_DB_TESTS !== '1') {
	fail(
		'Refusing to seed: use --disposable or PAGEBOX_DB_TESTS=1 for a disposable database. This takes the superadmin seat.'
	);
}
const email = (env.PAGEBOX_E2E_EMAIL ?? '').trim().toLowerCase();
const password = env.PAGEBOX_E2E_PASSWORD;
if (!email || !password) fail('Explicit PAGEBOX_E2E_EMAIL and PAGEBOX_E2E_PASSWORD are required.');
if (password.length < 10 || password.length > 200)
	fail('PAGEBOX_E2E_PASSWORD must contain between 10 and 200 characters.');
const DATABASE_URL =
	env.DATABASE_URL_HOST ?? env.DATABASE_URL?.replace('@postgres:', '@127.0.0.1:');
const S3_ENDPOINT = env.S3_ENDPOINT_HOST ?? env.S3_ENDPOINT?.replace('//minio:', '//127.0.0.1:');
validateUrl('DATABASE_URL', DATABASE_URL, ['postgres:', 'postgresql:']);
validateUrl('S3_ENDPOINT', S3_ENDPOINT, ['http:', 'https:']);
if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) fail('S3_ACCESS_KEY and S3_SECRET_KEY are required.');

const slug = argOf('slug', 'demo');
const dir = argOf('dir', null);
for (const candidate of [slug, slug + '-private', slug + '-api', slug + '-panel']) {
	if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(candidate))
		fail('The slug and fixture suffixes must fit the site slug rules.');
}
const files = dir ? readBuild(dir) : demoBuild();

const s3 = new S3Client({
	endpoint: S3_ENDPOINT,
	region: env.S3_REGION ?? 'us-east-1',
	forcePathStyle: true,
	credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY }
});
const bucket = env.S3_BUCKET ?? 'pagebox';
const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });

try {
	await ensureBucket();
	await seedTestSuperadmin();
	await seed(slug, 'public', files);
	await seed(`${slug}-private`, 'private', files);
	// Separate target for the deploy-API tests, which replace the active deployment and
	// would otherwise pull the ground out from under the serving tests.
	await seed(`${slug}-api`, 'public', files);
	// And one for the panel-upload suite, which also replaces the active deployment.
	await seed(`${slug}-panel`, 'public', files);
} finally {
	await sql.end();
}

console.log(`\nseeded ${files.length} files`);
console.log(`  public : ${env.PAGEBOX_SITES_PREFIX ?? '/s'}/${slug}/`);
console.log(`  private: ${env.PAGEBOX_SITES_PREFIX ?? '/s'}/${slug}-private/`);
console.log(`  api     : ${env.PAGEBOX_SITES_PREFIX ?? '/s'}/${slug}-api/   (deploy-API tests)`);
console.log(`  panel   : ${env.PAGEBOX_SITES_PREFIX ?? '/s'}/${slug}-panel/ (panel-upload tests)`);

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
		insert into deployment (id, site_id, status, file_count, total_bytes, source, notes)
		values (${deploymentId}, ${site.id}, 'uploading', ${entries.length}, ${total}, 'api', 'seed-demo')
	`;

	try {
		for (const entry of entries) {
			await s3.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: `sites/${site.id}/${deploymentId}/${entry.path}`,
					Body: entry.body
				})
			);
		}

		await sql.begin(async (tx) => {
			await tx`update deployment set status = 'ready', ready_at = now() where id = ${deploymentId}`;
			await tx`update site set active_deployment_id = ${deploymentId} where id = ${site.id}`;
		});
	} catch (error) {
		await sql`update deployment set status = 'cleanup_pending' where id = ${deploymentId}`;
		throw error;
	}
	console.log(`${siteSlug}: deployment ${deploymentId} active (${entries.length} files)`);
}

/**
 * An account for the integration suite, so the tests never touch the credentials a person
 * is actually using. Idempotent: the password is put back on every seed.
 *
 * The suite exercises superadmin-only screens, and there is exactly one superadmin seat —
 * a partial unique index enforces it — so seeding *takes* the seat and steps the previous
 * holder down to admin. On a dev instance that is the bootstrap account, which keeps its
 * sites and its accounts and can take the seat back from the Users page. It is loud about
 * it rather than quiet, because it is somebody's account.
 */
async function seedTestSuperadmin() {
	const hash = await hashPassword(password);

	const stepped = await sql.begin(async (tx) => {
		const [existing] = await tx`select id from "user" where email = ${email}`;
		const id = existing?.id ?? ulid();

		// Vacate before filling: the index permits one superadmin row, so the other order
		// collides with whoever holds it.
		const demoted = await tx`
		update "user" set role = 'admin', updated_at = now()
		where role = 'superadmin' and email <> ${email}
		returning email
	`;

		if (existing) {
			await tx`update "user" set role = 'superadmin', banned = false, must_change_password = false where id = ${id}`;
		} else {
			await tx`
			insert into "user" (id, email, name, email_verified, role, must_change_password)
			values (${id}, ${email}, 'E2E admin', true, 'superadmin', false)
		`;
		}

		const [account] = await tx`
		select id from account where user_id = ${id} and provider_id = 'credential'
	`;
		if (account) {
			await tx`update account set password = ${hash} where id = ${account.id}`;
		} else {
			await tx`
			insert into account (id, account_id, provider_id, user_id, password)
			values (${ulid()}, ${id}, 'credential', ${id}, ${hash})
		`;
		}

		await tx`delete from session where user_id = ${id}`;
		await tx`update apikey set enabled = false, updated_at = now() where reference_id = ${id}`;
		return demoted;
	});
	for (const row of stepped) console.log(`stepped down to admin: ${row.email}`);
	console.log(`test superadmin: ${email}`);
}

async function ensureBucket() {
	try {
		await s3.send(new HeadBucketCommand({ Bucket: bucket }));
	} catch (error) {
		if (error.$metadata?.httpStatusCode !== 404) throw error;
		await s3.send(new CreateBucketCommand({ Bucket: bucket }));
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
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
		throw new Error('Build root must be a directory, not a symbolic link');
	const out = [];
	const walk = (current) => {
		for (const name of readdirSync(current)) {
			if (name.startsWith('.') || ['__MACOSX', 'Thumbs.db'].includes(name)) continue;
			const full = join(current, name);
			const info = lstatSync(full);
			if (info.isSymbolicLink())
				throw new Error('Symbolic links are not allowed in build fixtures');
			if (info.isDirectory()) walk(full);
			else if (info.isFile())
				out.push({ path: relative(root, full).split(sep).join('/'), body: readFileSync(full) });
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

function fail(message) {
	console.error(message);
	process.exit(1);
}

function validateUrl(name, value, protocols) {
	try {
		if (!value || !protocols.includes(new URL(value).protocol)) throw new Error();
	} catch {
		fail(name + ' must be a valid URL using ' + protocols.join(' or '));
	}
}
