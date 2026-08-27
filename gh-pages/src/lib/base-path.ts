/**
 * The prefix this build is served under, for the paths Next does not rewrite.
 *
 * `next/link`, imported images and everything under `_next/static` already carry it.
 * What does not: `next/image` with a literal `src`, `metadata.icons`, and any absolute
 * path into `public/`. Those go through here.
 *
 * Read at build time from `next.config.mjs`, so there is exactly one definition of the
 * prefix in the project.
 */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function withBasePath(path: string): string {
  return `${basePath}${path}`;
}
