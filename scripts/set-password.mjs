/**
 * Recover an account from the database host. Explicit credentials are required unless
 * --from-env is supplied. --keep leaves the password usable without a forced change.
 *
 * node scripts/set-password.mjs --email a@b.com --password "..."
 */
import { existsSync, readFileSync } from 'node:fs';
import { hashPassword } from 'better-auth/crypto';
import postgres from 'postgres';
import { ulid } from 'ulidx';

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args[index + 1]?.startsWith('--') ? null : args[index + 1];
};

const env = { ...readEnvFile('.env'), ...readEnvFile('.env.local'), ...process.env };
const DATABASE_URL =
	env.DATABASE_URL_HOST ?? env.DATABASE_URL?.replace('@postgres:', '@127.0.0.1:');
const fromEnv = args.includes('--from-env');
const email = (argOf('email', fromEnv ? env.BOOTSTRAP_ADMIN_EMAIL : null) ?? '')
	.trim()
	.toLowerCase();
const password = argOf('password', fromEnv ? env.BOOTSTRAP_ADMIN_PASSWORD : null);
const keep = args.includes('--keep');

if (!DATABASE_URL) fail('no DATABASE_URL: set it in .env, .env.local or the environment');
if (!email) fail('--email is required (or --from-env to use BOOTSTRAP_ADMIN_EMAIL)');
if (!password) fail('--password is required (or --from-env to use BOOTSTRAP_ADMIN_PASSWORD)');
if (password.length < 10 || password.length > 200) fail('use between 10 and 200 characters');
try {
	if (!['postgres:', 'postgresql:'].includes(new URL(DATABASE_URL).protocol)) throw new Error();
} catch {
	fail('DATABASE_URL must be a PostgreSQL URL');
}

const hash = await hashPassword(password);
const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
try {
	const result = await sql.begin(async (tx) => {
		const [user] = await tx`select id, role from "user" where email = ${email}`;
		if (!user) throw Object.assign(new Error('account not found'), { code: 'PAGEBOX_NO_ACCOUNT' });
		const [account] = await tx`
			select id from account where user_id = ${user.id} and provider_id = 'credential'
		`;
		if (account) {
			await tx`update account set password = ${hash}, updated_at = now() where id = ${account.id}`;
		} else {
			await tx`
				insert into account (id, account_id, provider_id, user_id, password)
				values (${ulid()}, ${user.id}, 'credential', ${user.id}, ${hash})
			`;
		}
		await tx`update "user" set must_change_password = ${!keep}, updated_at = now() where id = ${user.id}`;
		const sessions = await tx`delete from session where user_id = ${user.id} returning id`;
		const keys = await tx`
			update apikey set enabled = false, updated_at = now()
			where reference_id = ${user.id} and enabled = true returning id
		`;
		const meta = {
			source: 'recovery-script',
			sessionsRevoked: sessions.length,
			keysRevoked: keys.length,
			mustChangePassword: !keep
		};
		await tx`
			insert into audit_log (id, action, target_type, target_id, meta)
			values (${ulid()}, 'user.password_reset', 'user', ${user.id}, ${tx.json(meta)})
		`;
		return { role: user.role, sessions: sessions.length, keys: keys.length };
	});
	console.log(`password set for ${email} (${result.role})`);
	console.log(`  ${result.sessions} session(s) and ${result.keys} API key(s) revoked`);
	console.log(
		keep ? '  the account can keep this password' : '  it must be changed at next sign-in'
	);
} catch (error) {
	console.error(
		error.code === 'PAGEBOX_NO_ACCOUNT'
			? `no account with email ${email}`
			: 'password reset failed; transaction rolled back'
	);
	process.exitCode = 1;
} finally {
	await sql.end();
}

function fail(message) {
	console.error(message);
	process.exit(1);
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
