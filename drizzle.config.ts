import { defineConfig } from 'drizzle-kit';

/** Local tooling only (`pnpm db:generate` / `db:migrate`). Production migrates at boot. */
export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema/*.ts',
	out: './drizzle',
	dbCredentials: {
		url: process.env.DATABASE_URL ?? 'postgres://pagebox:pagebox@localhost:5432/pagebox'
	},
	strict: true,
	verbose: true
});
