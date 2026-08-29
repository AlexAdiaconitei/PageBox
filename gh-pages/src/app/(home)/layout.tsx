import Link from 'next/link';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';
import { PageBoxMark } from '@/components/pagebox-mark';
import { appName, gitUrl, licence } from '@/lib/shared';

const FOOTER = [
  {
    heading: 'Start',
    links: [
      { text: 'Quickstart', href: '/docs/start/quickstart' },
      { text: 'How it fits together', href: '/docs/start/concepts' },
      { text: 'Your first site', href: '/docs/start/first-site' },
    ],
  },
  {
    heading: 'Deploy',
    links: [
      { text: 'Deploy API', href: '/docs/deploy/api' },
      { text: 'Base paths per generator', href: '/docs/deploy/base-paths' },
      { text: 'GitHub Actions', href: '/docs/deploy/ci' },
    ],
  },
  {
    heading: 'Operate',
    links: [
      { text: 'Accounts and grants', href: '/docs/operate/access' },
      { text: 'Storage and retention', href: '/docs/operate/storage' },
      { text: 'Configuration', href: '/docs/operate/configuration' },
    ],
  },
];

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <HomeLayout {...baseOptions()}>
      {children}

      <footer className="border-t border-pb-line bg-pb-rail">
        <div className="mx-auto grid w-full max-w-[74rem] gap-10 px-5 py-14 sm:px-8 md:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)]">
          <div>
            <p className="flex items-center gap-2 font-display text-[1.05rem] font-semibold tracking-tight text-pb-ink">
              <PageBoxMark className="size-5" />
              {appName}
            </p>
            <p className="mt-3 max-w-[34ch] text-[0.85rem] leading-relaxed text-pb-muted">
              Static hosting you run yourself, with access control that reaches every file.
            </p>
            <a
              href={gitUrl}
              className="mt-4 inline-block text-[0.85rem] font-medium text-pb-live hover:underline"
            >
              Source on GitHub
            </a>

            <p className="mt-4 text-[0.8rem] leading-relaxed text-pb-muted">
              <a href={licence.file} className="hover:text-pb-ink">
                {licence.spdx}
              </a>{' '}
              — free for personal use. Organisations need a licence:{' '}
              <a href={`mailto:${licence.email}`} className="font-medium text-pb-live hover:underline">
                {licence.email}
              </a>
            </p>
          </div>

          <nav className="grid gap-8 sm:grid-cols-3" aria-label="Documentation">
            {FOOTER.map((column) => (
              <div key={column.heading}>
                <p className="eyebrow">{column.heading}</p>
                <ul className="mt-3 space-y-2 text-[0.85rem]">
                  {column.links.map((link) => (
                    <li key={link.href}>
                      <Link href={link.href} className="text-pb-muted hover:text-pb-ink">
                        {link.text}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
      </footer>
    </HomeLayout>
  );
}
