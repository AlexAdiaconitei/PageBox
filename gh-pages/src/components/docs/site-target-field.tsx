'use client';

import { useSiteTarget } from './site-target';

/**
 * The one thing this page cannot know.
 *
 * Fill it in and every recipe below is written for your site instead of the example one —
 * which is the difference between reading a page about base paths and copying the line you
 * actually need. Kept where the reader lands rather than in a settings menu, because it is
 * only worth anything before they start pasting.
 */
export function SiteTargetField() {
  const { host, slug, target, setSite, reset } = useSiteTarget();

  return (
    <div className="not-prose my-6 rounded-xl border border-pb-line bg-pb-panel">
      <div className="flex flex-wrap items-end gap-4 p-4">
        <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1.5">
          <span className="eyebrow">Sites host</span>
          <input
            type="text"
            value={host}
            spellCheck={false}
            onChange={(fieldEvent) => setSite({ host: fieldEvent.target.value })}
            className="w-full rounded-lg border border-pb-line bg-pb-page px-3 py-2 font-mono text-[0.82rem] text-pb-ink focus-visible:border-pb-live focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-pb-live"
          />
        </label>

        <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1.5">
          <span className="eyebrow">Site slug</span>
          <input
            type="text"
            value={slug}
            spellCheck={false}
            onChange={(fieldEvent) => setSite({ slug: fieldEvent.target.value })}
            className="w-full rounded-lg border border-pb-line bg-pb-page px-3 py-2 font-mono text-[0.82rem] text-pb-ink focus-visible:border-pb-live focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-pb-live"
          />
        </label>

        <button
          type="button"
          onClick={reset}
          className="rounded-lg border border-pb-line px-3 py-2 text-[0.8rem] text-pb-muted transition-colors hover:bg-pb-raise hover:text-pb-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pb-live motion-reduce:transition-none"
        >
          Use the example
        </button>
      </div>

      <p className="border-t border-pb-line bg-pb-rail px-4 py-3 text-[0.8rem] text-pb-muted">
        Every recipe on this page now targets{' '}
        <code className="font-mono text-[0.9em] text-pb-live">{target.url}</code>. Ask the
        API for it instead of typing it — <code className="font-mono text-[0.9em]">GET
        /api/v1/whoami</code> answers with this site&rsquo;s <code className="font-mono text-[0.9em]">basePath</code>.
      </p>
    </div>
  );
}
