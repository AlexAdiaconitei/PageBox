import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const read = (name) => readFile(`security-checks/${name}`, 'utf8');
const checks = [
	['format-final.log', /All matched files use Prettier code style/],
	['check-final.log', /found 0 errors and 0 warnings/],
	['unit-final.log', /Tests\s+168 passed/],
	['integration-final.log', /Tests\s+110 passed/],
	['build-final.log', /✔ done/],
	['docs-build.log', /Generating static pages/],
	['docs-types.log', /Types generated successfully/],
	['docker-smoke.log', /Docker smoke passed/],
	['router-results.log', /Traefik router passed/],
	['storage-policy.log', /Storage policy passed/]
];
for (const [file, pattern] of checks) assert.match(await read(file), pattern, file);
assert.doesNotMatch(await read('docs-lint.log'), /error|warning/i);
for (const file of ['docs-build.log', 'docs-types.log', 'docker-build.log'])
	assert.doesNotMatch(await read(file), /ELIFECYCLE|Failed to compile|ERROR:/);
const appAudit = JSON.parse(await read('app-audit-after.json'));
const docsAudit = JSON.parse(await read('docs-audit-after.json'));
assert.equal(Object.keys(appAudit.advisories).length, 0);
assert.deepEqual(
	Object.values(docsAudit.advisories).map((x) => x.github_advisory_id),
	['GHSA-vfj7-8cjw-p6xm']
);
const guards = JSON.parse(await read('script-results.json'));
const entrypoint = JSON.parse(await read('entrypoint-results.json'));
const compose = JSON.parse(await read('compose-results.json'));
assert.equal(guards.passed, 17);
assert.equal(entrypoint.passed, 6);
assert.equal(compose.checks.length, 14);
const report = {
	checkedAt: new Date().toISOString(),
	version: '0.2.0',
	published: false,
	unitTests: { passed: 168, failed: 0 },
	integrationTests: { passed: 110, failed: 0, databasePoolMax: 1, chromium: true },
	types: 'passed',
	format: 'passed',
	appBuild: 'passed',
	docsBuild: 'passed',
	docsTypes: 'passed',
	docsLint: 'passed',
	dockerBuild: 'passed',
	dockerSmoke: 'passed',
	traefikRouter: 'passed',
	restrictedStoragePolicy: 'passed',
	scriptGuards: 17,
	entrypointChecks: 6,
	composeChecks: 14,
	appDependencyAdvisories: 0,
	docsDependencyException: {
		advisory: 'GHSA-vfj7-8cjw-p6xm',
		package: 'braces',
		severity: 'high',
		patchedRelease: null,
		exposure: 'local ESLint repository patterns; absent from exported docs and app image'
	},
	homelabModified: false,
	publicDnsAndTlsTested: false,
	commands: [
		'pnpm check',
		'pnpm format:check',
		'pnpm vitest run tests/unit',
		'node scripts/test-stack.mjs',
		'pnpm build',
		'pnpm audit --json',
		'pnpm -C gh-pages lint',
		'pnpm -C gh-pages build',
		'pnpm -C gh-pages types:check',
		'docker build -t ghcr.io/alexadiaconitei/pagebox:0.2.0 .',
		'node scripts/smoke-image.mjs ghcr.io/alexadiaconitei/pagebox:0.2.0',
		'node scripts/check-router.mjs',
		'node scripts/check-storage-policy.mjs'
	]
};
await writeFile('security-checks/verification.json', JSON.stringify(report, null, 2) + '\n');
console.log('Final verification passed: 278 tests plus deployment and dependency checks.');
