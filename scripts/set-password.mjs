/**
 * Sets an account's password from the machine that runs the database.
 *
 * The BOOTSTRAP_ADMIN_* variables only apply while the instance has no users — otherwise a
 * restart would reopen a closed account — so once someone has signed in and changed their
 * password, those variables are inert and a forgotten password has no way back. There is
 * no email delivery yet, so this is the way back: physical access to the deployment.
 *
 *   node scripts/set-password.mjs --email a@b.com --password "…"
 *   node scripts/set-password.mjs --email a@b.com --password "…" --keep   # do not force a change
 *   node scripts/set-password.mjs --from-env    # put the .env bootstrap credentials back
 *
 * The .env fallback is behind --from-env on purpose: run by accident, it silently replaces
 * whatever password the account's owner had chosen.
 *
 * The account is flagged `must_change_password` unless --keep is given: a password typed
 * on a command line has been in a shell history.
 */
import { existsSync, readFileSync } from 'node:fs';
import { hashPassword } from 'better-auth/crypto';
import postgres from 'postgres';
import { ulid } from 'ulidx';

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args[index + 1];
};

const env = { ...readEnvFile('.env'), ...readEnvFile('.env.local'), ...process.env };
const DATABASE_URL =
	env.DATABASE_URL_HOST ?? env.DATABASE_URL?.replace('@postgres:', '@127.0.0.1:');

const fromEnv = args.includes('--from-env');
const email = (argOf('email', fromEnv ? env.BOOTSTRAP_ADMIN_EMAIL : null) ?? '').toLowerCase();
const password = argOf('password', fromEnv ? env.BOOTSTRAP_ADMIN_PASSWORD : null);
const keep = args.includes('--keep');

if (!DATABASE_URL) fail('no DATABASE_URL — set it in .env, .env.local or the environment');
if (!email) fail('--email is required (or --from-env to use BOOTSTRAP_ADMIN_EMAIL)');
if (!password) fail('--password is required (or --from-env to use BOOTSTRAP_ADMIN_PASSWORD)');
if (password.length < 10) fail('use at least 10 characters');

const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });

const [user] = await sql`select id, role from "user" where email = ${email}`;
if (!user) {
	await sql.end();
	fail(`no account with email ${email}`);
}

const hash = await hashPassword(password);
const [account] = await sql`
	select id from account where user_id = ${user.id} and provider_id = 'credential'
`;

if (account) {
	await sql`update account set password = ${hash}, updated_at = now() where id = ${account.id}`;
} else {
	// An account row can be missing if the user was created through a provider PageBox no
	// longer uses; giving it a credential row is what makes a password login possible.
	await sql`
		insert into account (id, account_id, provider_id, user_id, password)
		values (${ulid()}, ${user.id}, 'credential', ${user.id}, ${hash})
	`;
}

await sql`update "user" set must_change_password = ${!keep}, updated_at = now() where id = ${user.id}`;
// Any session opened with the old password stops working.
const revoked = await sql`delete from session where user_id = ${user.id} returning id`;
await sql.end();

console.log(`password set for ${email} (${user.role})`);
console.log(`  ${revoked.length} session(s) revoked`);
console.log(keep ? '  the account can keep this password' : '  it must be changed at next sign-in');

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
