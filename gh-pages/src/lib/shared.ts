export const appName = 'PageBox';
export const tagline = 'Static hosting you run yourself, with access control that reaches every file.';

export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const gitConfig = {
  user: 'AlexAdiaconitei',
  repo: 'PageBox',
  branch: 'main',
};

export const gitUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;

/** Licence, and where an organisation writes to buy one. */
export const licence = {
  name: 'Business Source License 1.1',
  spdx: 'BUSL-1.1',
  /** The date this version turns into its Change License, Apache 2.0. */
  changeDate: '29 August 2030',
  file: `${gitUrl}/blob/main/LICENSE`,
  email: 'alexibs98@gmail.com',
};

/** Prefilled so the first message already says which product it is about. */
export const licenceMailto =
  `mailto:${licence.email}` +
  `?subject=${encodeURIComponent('PageBox — commercial licence enquiry')}` +
  `&body=${encodeURIComponent(
    [
      'Organisation:',
      'What you would run it for:',
      'Rough number of people using the panel:',
      '',
    ].join('\n'),
  )}`;

/** Placeholder hostnames used throughout the docs, so every example reads the same. */
export const example = {
  admin: 'pagebox.example.com',
  sites: 'pages.example.com',
  slug: 'docs',
};
