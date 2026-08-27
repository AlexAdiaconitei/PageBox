import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitUrl } from './shared';
import { PageBoxMark } from '@/components/pagebox-mark';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2">
          <PageBoxMark className="size-[1.4em]" />
          <span className="font-display font-semibold tracking-tight text-[1.05em]">{appName}</span>
        </span>
      ),
    },
    // `on: 'nav'` keeps these out of the docs sidebar, where the page tree already lists
    // every one of them and a second "Documentation" above it reads as a mistake.
    links: [
      { text: 'Documentation', url: '/docs', active: 'nested-url', on: 'nav' },
      { text: 'Deploy API', url: '/docs/deploy/api', on: 'nav' },
      { text: 'Self-host', url: '/docs/install/docker-compose', on: 'nav' },
    ],
    githubUrl: gitUrl,
  };
}
