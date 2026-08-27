'use client';

import { useSiteTarget } from './site-target';

type Kind = 'path' | 'path-no-slash' | 'url' | 'origin' | 'slug' | 'host';

/**
 * One value from the reader's site, inline in a sentence.
 *
 * `path` is how PageBox stores it — `/s/docs/`, both slashes. Everything else is derived,
 * because the slashes are exactly what people get wrong and a sentence should never make
 * the reader do that arithmetic.
 */
export function Prefix({ kind = 'path' }: { kind?: Kind }) {
  const { target, slug, host } = useSiteTarget();

  const value = {
    path: target.basePath,
    'path-no-slash': target.basePath.replace(/\/$/, ''),
    url: target.url,
    origin: `https://${host}`,
    slug,
    host,
  }[kind];

  return <code className="font-mono text-[0.9em] text-pb-live">{value}</code>;
}
