import Image from 'next/image';
import { withBasePath } from '@/lib/base-path';

/**
 * A panel screenshot, in the reader's own theme.
 *
 * Most shots exist twice, light and dark. Both are emitted and one is hidden, rather than
 * swapped in JavaScript, so the right one is already on screen when the page paints —
 * a console screenshot on the wrong ground is worse than no screenshot.
 *
 * `next/image` does not apply `basePath` to a literal `src`, which is why every path here
 * goes through `withBasePath`. That is the same trap the deployment docs warn about, and
 * this site would 404 its own screenshots on GitHub Pages without it.
 */

export type ShotName =
  | 'sites'
  | 'site-detail'
  | 'users'
  | 'audit'
  | 'served-site'
  | 'not-found'
  | 'sites-phone'
  | 'banner';

const SHOTS: Record<ShotName, { width: number; height: number; dark: boolean }> = {
  sites: { width: 2880, height: 1206, dark: true },
  'site-detail': { width: 2880, height: 2020, dark: true },
  users: { width: 2880, height: 1544, dark: false },
  audit: { width: 2880, height: 1258, dark: false },
  'served-site': { width: 2880, height: 1258, dark: false },
  'not-found': { width: 2880, height: 1240, dark: true },
  'sites-phone': { width: 860, height: 2000, dark: false },
  banner: { width: 2400, height: 392, dark: true },
};

export function Shot({
  name,
  alt,
  caption,
  priority = false,
  className = '',
  sizes = '(min-width: 1280px) 1100px, 100vw',
}: {
  name: ShotName;
  alt: string;
  caption?: string;
  priority?: boolean;
  className?: string;
  sizes?: string;
}) {
  const shot = SHOTS[name];

  return (
    <figure className={`m-0 ${className}`}>
      {/* A shot with no dark twin is a light plate on a dark page. Rather than pretend
          otherwise, it gets a visible mount in dark mode — a little inset and a rim — so
          it reads as something placed on the page instead of a hole burned through it. */}
      <div
        className={`overflow-hidden rounded-xl border border-pb-line bg-pb-panel shadow-[0_1px_2px_oklch(0_0_0/0.04),0_22px_50px_-34px_oklch(0_0_0/0.35)] ${
          shot.dark ? '' : 'dark:bg-pb-rail dark:p-1.5'
        }`}
      >
        <Image
          src={withBasePath(`/media/${name}.png`)}
          alt={alt}
          width={shot.width}
          height={shot.height}
          sizes={sizes}
          priority={priority}
          className={`h-auto w-full ${shot.dark ? 'dark:hidden' : 'dark:rounded-lg'}`}
        />
        {shot.dark ? (
          <Image
            src={withBasePath(`/media/${name}-dark.png`)}
            alt=""
            width={shot.width}
            height={shot.height}
            sizes={sizes}
            priority={priority}
            className="hidden h-auto w-full dark:block"
          />
        ) : null}
      </div>
      {caption ? (
        <figcaption className="mt-3 text-[0.8rem] leading-relaxed text-pb-faint">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
