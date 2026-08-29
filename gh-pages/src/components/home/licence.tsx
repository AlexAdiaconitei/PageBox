import { ArrowUpRight, Check } from 'lucide-react';

import { licence, licenceMailto } from '@/lib/shared';

/**
 * Who pays, said once and in the open.
 *
 * The two columns exist because the line is not the usual one: it does not run between
 * public and private, or between hosted and self-hosted, but between a person and an
 * organisation — so a reader looking for "can I just run this" has to find their own case
 * rather than infer it from a licence name they may not know.
 */
const FREE = [
  'A personal instance, on your own machine or your own server',
  'A hobby project, study, research, an experiment',
  'Reading, modifying, forking and redistributing the source',
  'Evaluating it — non-production use is free for anyone, organisations included',
];

const LICENSED = [
  'A company, whatever its size',
  'A government body, a public institution, a school',
  'A non-profit or any other legal entity',
  'A private internal deployment nobody outside ever sees',
];

export function Licence() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-2xl border border-pb-line bg-pb-panel p-6 sm:p-7">
        <p className="eyebrow">Personal use</p>
        <p className="mt-2 font-display text-[1.6rem] font-semibold tracking-tight text-pb-ink">
          Free
        </p>
        <p className="mt-2 text-[0.9rem] leading-relaxed text-pb-muted">
          Nothing to sign, nothing to ask for. Run it.
        </p>

        <ul className="mt-5 space-y-2.5">
          {FREE.map((item) => (
            <li key={item} className="flex gap-2.5 text-[0.875rem] leading-relaxed text-pb-ink">
              <Check className="mt-0.5 size-4 shrink-0 text-pb-live" aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-2xl border border-pb-line bg-pb-panel p-6 sm:p-7">
        <p className="eyebrow">Organisations</p>
        <p className="mt-2 font-display text-[1.6rem] font-semibold tracking-tight text-pb-ink">
          Commercial licence
        </p>
        <p className="mt-2 text-[0.9rem] leading-relaxed text-pb-muted">
          Write and we will sort it out. There is no form and no sales call.
        </p>

        <ul className="mt-5 space-y-2.5">
          {LICENSED.map((item) => (
            <li key={item} className="flex gap-2.5 text-[0.875rem] leading-relaxed text-pb-ink">
              <span
                className="mt-2 size-1.5 shrink-0 rounded-full bg-pb-muted"
                aria-hidden="true"
              />
              {item}
            </li>
          ))}
        </ul>

        <a
          href={licenceMailto}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-pb-live px-4 py-2.5 text-[0.9rem] font-medium text-pb-live-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pb-live motion-reduce:transition-none"
        >
          Ask about a licence
          <ArrowUpRight className="size-4" />
        </a>

        {/* The address in full as well as behind the button: a mailto: is useless to
            somebody reading this on a machine with no mail client configured. */}
        <p className="mt-3 font-mono text-[0.8rem] text-pb-muted">
          <a href={`mailto:${licence.email}`} className="hover:text-pb-ink">
            {licence.email}
          </a>
        </p>
      </div>

      <p className="lg:col-span-2 text-[0.85rem] leading-relaxed text-pb-muted">
        PageBox is published under the{' '}
        <a href={licence.file} className="font-medium text-pb-live hover:underline">
          {licence.name}
        </a>
        . The source is public and always will be — this is not a licence that hides code, it
        is one that asks organisations to pay for production use. On{' '}
        <strong className="font-medium text-pb-ink">{licence.changeDate}</strong> this version
        becomes Apache 2.0 outright, and every later version four years after its own release.
      </p>
    </div>
  );
}
