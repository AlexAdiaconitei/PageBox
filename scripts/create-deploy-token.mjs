/**
 * Issues a deploy token from the command line, until the panel can do it (M3).
 *
 *   node scripts/create-deploy-token.mjs --site demo --name "github actions"
 *   node scripts/create-deploy-token.mjs --name "all sites"        # unscoped token
 *
 * Prints the token once. Only its sha256 is stored, so a lost token is reissued, never
 * recovered.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import postgres from 'postgres';
import { ulid } from 'ulidx';

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const env = { ...readEnvFile('.env'), ...process.env };
const DATABASE_URL = env.DATABASE_URL_HOST ?? env.DATABASE_URL.replace('@postgres:', '@127.0.0.1:');

const slug = argOf('site');
const name = argOf('name', slug ? `${slug} deploys` : 'all sites');
const expiresInDays = Number(argOf('expires-in-days', 0));

const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });

let siteId = null;
if (slug) {
	const [row] = await sql`select id from site where slug = ${slug}`;
	if (!row) {
		console.error(`no site with slug "${slug}"`);
		await sql.end();
		process.exit(1);
	}
	siteId = row.id;
}

const token = 'pbx_' + randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const expiresAt = expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86400_000) : null;

await sql`
	insert into deploy_token (id, site_id, name, token_hash, prefix, expires_at)
	values (${ulid()}, ${siteId}, ${name}, ${hash}, ${token.slice(0, 12)}, ${expiresAt})
`;
await sql.end();

console.log(`token for ${slug ?? 'all sites'} (${name}):\n`);
console.log(token);
console.log('\nshown once — store it now.');

function readEnvFile(path) {
	if (!existsSync(path)) return {};
	const out = {};
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
		if (match) out[match[1]] = match[2];
	}
	return out;
}
