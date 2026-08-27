'use client';

import { useState } from 'react';
import { example } from '@/lib/shared';

/**
 * The landing page's one interactive element, because it is the one claim that is hard to
 * believe from a sentence: a rollback here is a pointer move, not a rebuild.
 *
 * So the ledger is real enough to operate. Every build a site has had stays listed with
 * what it weighed and what it was pushed with; exactly one carries the live marker; moving
 * the marker is a click and nothing else changes. That is the product, at the size of a
 * card.
 */

type Deployment = {
  id: string;
  bytes: string;
  files: number;
  source: string;
  note: string;
  when: string;
};

const DEPLOYMENTS: Deployment[] = [
  {
    id: '01JQ8F3ZP7K2M9XR4T6B',
    bytes: '4.7 MB',
    files: 812,
    source: 'token',
    note: 'main@a1b2c3d',
    when: '2 hours ago',
  },
  {
    id: '01JQ7W1HD4N8V0CJ5S2E',
    bytes: '4.7 MB',
    files: 809,
    source: 'token',
    note: 'main@9f31e07',
    when: 'yesterday',
  },
  {
    id: '01JQ5R9XA2G6Y3PL8M1K',
    bytes: '4.6 MB',
    files: 804,
    source: 'drop',
    note: 'nav fix, by hand',
    when: '3 days ago',
  },
  {
    id: '01JQ2C0BE5T7Q1WH6D4N',
    bytes: '4.6 MB',
    files: 804,
    source: 'token',
    note: 'main@77c0aa9',
    when: 'last week',
  },
];

export function DeploymentLedger() {
  const [liveId, setLiveId] = useState(DEPLOYMENTS[0].id);
  const live = DEPLOYMENTS.find((deployment) => deployment.id === liveId)!;

  return (
    <figure className="m-0">
      <div className="overflow-hidden rounded-xl border border-pb-line bg-pb-panel shadow-[0_1px_2px_oklch(0_0_0/0.04),0_18px_40px_-28px_oklch(0_0_0/0.28)]">
        {/* What the site is answering with right now. The address never changes; the
            deployment behind it does, which is the entire point. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-pb-line bg-pb-rail px-4 py-3">
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-pb-live opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-2 rounded-full bg-pb-live" />
          </span>
          <code className="font-mono text-[0.78rem] text-pb-ink">
            {example.sites}/s/{example.slug}/
          </code>
          <span className="ml-auto font-mono text-[0.7rem] text-pb-faint" aria-live="polite">
            serving <span className="text-pb-muted">{live.id.slice(0, 10)}…</span> · {live.note}
          </span>
        </div>

        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            Deployment history for the site {example.slug}. One deployment is live; the
            others can be made live.
          </caption>
          <thead>
            <tr className="eyebrow">
              <th scope="col" className="px-4 py-2 font-medium">
                Deployment
              </th>
              <th scope="col" className="hidden px-4 py-2 text-right font-medium sm:table-cell">
                Size
              </th>
              <th scope="col" className="hidden px-4 py-2 text-right font-medium md:table-cell">
                Files
              </th>
              <th scope="col" className="hidden px-4 py-2 font-medium lg:table-cell">
                Source
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                <span className="sr-only">State</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {DEPLOYMENTS.map((deployment) => {
              const isLive = deployment.id === liveId;

              return (
                <tr
                  key={deployment.id}
                  className={`border-t border-pb-line-soft transition-colors motion-reduce:transition-none ${
                    isLive ? 'bg-pb-live-soft' : ''
                  }`}
                >
                  <th scope="row" className="px-4 py-2.5 font-normal">
                    <span className="flex items-baseline gap-2">
                      {/* The marker is a rule down the row's edge, not a badge: it reads
                          as a pointer resting on one line of a list. */}
                      <span
                        aria-hidden="true"
                        className={`-ml-4 mr-1 h-4 w-[3px] shrink-0 self-center rounded-full transition-colors motion-reduce:transition-none ${
                          isLive ? 'bg-pb-live' : 'bg-transparent'
                        }`}
                      />
                      <code className="font-mono text-[0.78rem] text-pb-ink">
                        {deployment.id.slice(0, 12)}
                      </code>
                      {/* On a phone the note moves to the line below rather than being
                          truncated to three characters, where it says nothing at all. */}
                      <span className="hidden truncate text-[0.72rem] text-pb-faint sm:inline">
                        {deployment.note}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[0.7rem] text-pb-faint sm:hidden">
                      {deployment.note} · {deployment.bytes} · {deployment.when}
                    </span>
                  </th>
                  <td className="hidden px-4 py-2.5 text-right font-mono text-[0.75rem] text-pb-muted sm:table-cell">
                    {deployment.bytes}
                  </td>
                  <td className="hidden px-4 py-2.5 text-right font-mono text-[0.75rem] text-pb-muted md:table-cell">
                    {deployment.files}
                  </td>
                  <td className="hidden px-4 py-2.5 text-[0.75rem] text-pb-muted lg:table-cell">
                    {deployment.source}
                    <span className="text-pb-faint"> · {deployment.when}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {isLive ? (
                      <span className="eyebrow text-pb-live">Live</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setLiveId(deployment.id)}
                        className="whitespace-nowrap rounded-md border border-pb-line px-2 py-1 font-mono text-[0.7rem] text-pb-muted transition-colors hover:border-pb-live hover:bg-pb-raise hover:text-pb-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pb-live motion-reduce:transition-none"
                      >
                        Make live
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <figcaption className="mt-3 text-[0.8rem] text-pb-faint">
        Try it — the marker moves and nothing else does. In the panel it is the same click:
        no rebuild, no re-upload.
      </figcaption>
    </figure>
  );
}
