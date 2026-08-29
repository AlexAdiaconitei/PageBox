import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-node';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Vite prints `http://localhost:5173/`, which is the one address PageBox does not answer
 * on: it routes by hostname, so plain localhost is neither the panel nor the site host and
 * gets a 404. Print what actually works instead.
 */
function pageboxDevUrls(): Plugin {
	return {
		name: 'pagebox:dev-urls',
		configureServer(server) {
			server.printUrls = () => {
				const port = server.config.server.port ?? 5173;
				const admin = process.env.PAGEBOX_ADMIN_HOST ?? 'pagebox.localhost';
				const sites = process.env.PAGEBOX_SITES_HOST ?? 'pages.localhost';
				const prefix = process.env.PAGEBOX_SITES_PREFIX ?? '/s';

				console.log(`\n  \x1b[32m➜\x1b[0m  \x1b[1mPanel\x1b[0m:  http://${admin}:${port}/`);
				console.log(
					`  \x1b[32m➜\x1b[0m  \x1b[1mSites\x1b[0m:  http://${sites}:${port}${prefix}/<slug>/`
				);
				console.log(
					`  \x1b[2m     PageBox routes by hostname — plain localhost answers 404.\x1b[0m\n`
				);
			};
		}
	};
}

// The panel shows the running version next to the repository link, and an image is the
// one place where nobody can check `package.json` — so it is compiled in rather than read
// from disk at runtime, where the file may or may not be beside the bundle.
const { version } = JSON.parse(
	readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string };

export default defineConfig({
	define: {
		__PAGEBOX_VERSION__: JSON.stringify(version)
	},
	plugins: [
		pageboxDevUrls(),
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// PageBox serves two hostnames from one deployable, so `event.url` must be built
			// from the proxy headers (HOST_HEADER/PROTOCOL_HEADER) — never from a fixed
			// ORIGIN, which would collapse both hosts into one and disable the host split
			// (see docs/IMPLEMENTATION-PLAN.md §1.1 B3).
			adapter: adapter(),

			// SvelteKit's built-in check compares Origin against that derived URL, so a
			// proxy that forwards the host but not x-forwarded-proto turns every form POST
			// into a confusing 403 — and `trustedOrigins` cannot help, since our hostnames
			// are runtime configuration. hooks.server.ts enforces same-origin itself
			// against PAGEBOX_ADMIN_HOST / PAGEBOX_SITES_HOST instead.
			csrf: { checkOrigin: false }
		})
	],
	test: {
		include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
		setupFiles: ['tests/setup-env.ts']
	}
});
