/**
 * Who made this and which build is running. The panel links to the repository from the
 * rail: an instance an operator inherits should say where it came from without them
 * having to find the person who deployed it.
 */
export const REPO_URL = 'https://github.com/AlexAdiaconitei/PageBox';

/** Injected at build time from package.json (vite.config.ts `define`). */
export const VERSION = __PAGEBOX_VERSION__;
