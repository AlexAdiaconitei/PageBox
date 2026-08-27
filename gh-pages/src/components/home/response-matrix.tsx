import type { ReactNode } from 'react';

/**
 * What a private site answers, by caller.
 *
 * The status codes are the vocabulary here — an operator reads this table by scanning the
 * right-hand column — so they are set in mono and coloured by what they mean: refused,
 * redirected, or served. Nothing else on the page uses those two extra colours.
 */

type Row = {
  caller: string;
  code: string;
  tone: 'served' | 'refused' | 'redirect';
  answer: ReactNode;
};

const ROWS: Row[] = [
  {
    caller: 'Granted, directly or through a group',
    code: '200',
    tone: 'served',
    answer: 'The file.',
  },
  {
    caller: 'Signed in, no grant',
    code: '404',
    tone: 'refused',
    answer: 'The same answer as a site that does not exist.',
  },
  {
    caller: 'Anonymous, navigating',
    code: '302',
    tone: 'redirect',
    answer: 'To the sign-in page — a person can act on that.',
  },
  {
    caller: 'Anonymous, sub-resource',
    code: '401',
    tone: 'refused',
    answer:
      'No Location: a redirect answering a <script src> would arrive as HTML where code was expected.',
  },
];

const TONE: Record<Row['tone'], string> = {
  served: 'text-pb-live bg-pb-live-soft',
  refused: 'text-pb-refused bg-pb-refused-soft',
  redirect: 'text-pb-redirect bg-pb-redirect-soft',
};

export function ResponseMatrix() {
  return (
    <div className="overflow-hidden rounded-xl border border-pb-line bg-pb-panel">
      <ul className="m-0 list-none p-0">
        {ROWS.map((row) => (
          <li
            key={row.code + row.caller}
            className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-x-4 gap-y-1 border-b border-pb-line-soft px-4 py-4 last:border-b-0 sm:grid-cols-[4rem_14rem_minmax(0,1fr)] sm:items-center sm:gap-x-6"
          >
            <code
              className={`inline-flex justify-center rounded-md px-1.5 py-1 font-mono text-[0.78rem] font-medium ${TONE[row.tone]}`}
            >
              {row.code}
            </code>
            <p className="m-0 text-[0.9rem] font-medium text-pb-ink">{row.caller}</p>
            <p className="col-start-2 m-0 text-[0.85rem] leading-relaxed text-pb-muted sm:col-start-3">
              {row.answer}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
