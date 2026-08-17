import adapter from '@sveltejs/adapter-node';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
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
			// (see IMPLEMENTATION-PLAN.md §1.1 B3).
			adapter: adapter()
		})
	],
	test: {
		include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
		setupFiles: ['tests/setup-env.ts']
	}
});
