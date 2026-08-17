/**
 * M2 acceptance check: build a real generator output against the base path the API hands
 * out, deploy it through the API, then walk the served HTML and assert that every local
 * reference resolves. A build that "deploys fine" but 404s on its own assets is the
 * failure mode this whole design is trying to avoid.
 *
 *   PAGEBOX_E2E_BASE=http://127.0.0.1:3000 PAGEBOX_E2E_TOKEN=pbx_... \
 *     node scripts/verify-real-build.mjs
 *
 * Uses Vite as the generator (it is already a dependency); the same shape applies to
 * Docusaurus `baseUrl`, Next `basePath`, Astro `base` and SvelteKit `paths.base`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { zipSync } from 'fflate';

const base = process.env.PAGEBOX_E2E_BASE ?? 'http://127.0.0.1:3000';
const token = process.env.PAGEBOX_E2E_TOKEN;
const adminHost = process.env.PAGEBOX_E2E_ADMIN_HOST ?? 'pagebox.localhost';
const sitesHost = process.env.PAGEBOX_E2E_SITES_HOST ?? 'pages.localhost';
const hostHeader = process.env.PAGEBOX_E2E_HOST_HEADER ?? 'x-forwarded-host';

if (!token) {
	console.error('PAGEBOX_E2E_TOKEN is required (scripts/create-deploy-token.mjs)');
	process.exit(1);
}

// 1. Ask the API what to build for, exactly as a CI job would.
const whoami = await fetch(`${base}/api/v1/whoami`, {
	headers: { [hostHeader]: adminHost, authorization: `Bearer ${token}` }
}).then((res) => res.json());

if (!whoami.basePath) {
	console.error('token is not scoped to a site, so there is no base path to build for');
	process.exit(1);
}
console.log(`building for ${whoami.slug} with base ${whoami.basePath}`);

// 2. Build.
const root = fileURLToPath(new URL('../tests/fixtures/real-site', import.meta.url));
const outDir = join(root, 'dist');
await build({
	root,
	base: whoami.basePath,
	logLevel: 'warn',
	build: { outDir, emptyOutDir: true }
});

// 3. Zip and upload.
const files = {};
for (const path of walk(outDir)) {
	files[relative(outDir, path).split(sep).join('/')] = new Uint8Array(readFileSync(path));
}
const archive = zipSync(files, { level: 6 });

const deployed = await fetch(`${base}/api/v1/sites/${whoami.slug}/deployments`, {
	method: 'POST',
	headers: {
		[hostHeader]: adminHost,
		authorization: `Bearer ${token}`,
		'content-type': 'application/zip',
		'x-deployment-notes': 'verify-real-build'
	},
	body: archive
}).then((res) => res.json());

if (!deployed.deploymentId) {
	console.error('deploy failed:', deployed);
	process.exit(1);
}
console.log(`deployed ${deployed.fileCount} files as ${deployed.deploymentId}`);

// 4. Fetch the page and check every local reference it names.
const page = await fetch(`${base}${whoami.basePath}`, { headers: { [hostHeader]: sitesHost } });
const html = await page.text();
if (page.status !== 200) {
	console.error(`site root answered ${page.status}`);
	process.exit(1);
}

const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
	.map((match) => match[1])
	.filter((ref) => !/^(https?:)?\/\//.test(ref) && !ref.startsWith('data:'));

let broken = 0;
for (const ref of refs) {
	const url = new URL(ref, `http://placeholder${whoami.basePath}`).pathname;
	const res = await fetch(`${base}${url}`, {
		method: 'HEAD',
		headers: { [hostHeader]: sitesHost }
	});
	const ok = res.status === 200;
	if (!ok) broken++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${res.status} ${url}`);
}

if (broken > 0) {
	console.error(`\n${broken} of ${refs.length} references are broken`);
	process.exit(1);
}
console.log(`\nall ${refs.length} references resolve — real build served clean`);

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) yield* walk(full);
		else yield full;
	}
}
