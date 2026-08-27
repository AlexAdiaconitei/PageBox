import type { Metadata } from 'next';
import { Inter, Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import { Provider } from '@/components/provider';
import { appName, tagline } from '@/lib/shared';
import { withBasePath } from '@/lib/base-path';
import './global.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

const instrumentSans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-instrument-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

/*
 * `metadataBase` is only ever used to absolutise the OG image URL. The site answers on
 * three different origins depending on how it was deployed, so it is configuration, not
 * a constant — DOCS_SITE_URL in the workflow that builds it.
 */
const siteUrl = process.env.DOCS_SITE_URL ?? 'https://alexadiaconitei.github.io/PageBox/';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${appName} — self-hosted static hosting with access control`,
    template: `%s · ${appName}`,
  },
  description: tagline,
  applicationName: appName,
  // metadata.icons is one of the paths Next does not prefix for you. See
  // content/docs/generators/next.mdx, where this line is the worked example.
  //
  // The files are the application's own, copied from static/: one SVG that answers the tab
  // strip's colour scheme, and a PNG for the platforms that ignore it.
  icons: {
    icon: withBasePath('/brand/favicon.svg'),
    apple: withBasePath('/brand/apple-touch-icon.png'),
  },
  openGraph: {
    title: appName,
    description: tagline,
    siteName: appName,
    type: 'website',
  },
  twitter: { card: 'summary_large_image', title: appName, description: tagline },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${instrumentSans.variable} ${jetbrainsMono.variable} font-sans`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
