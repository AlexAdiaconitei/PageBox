import type { ReactNode } from 'react';

/**
 * Every band on this page is a hairline rule, a label in the left gutter, and the content.
 *
 * The label sits beside the content rather than centred above it because that is how a
 * spec sheet reads, and because the page is not a sequence — there is no first or fifth
 * thing about PageBox, so numbering the sections would assert an order that is not there.
 */
export function Section({
  label,
  title,
  lede,
  children,
  id,
}: {
  label: string;
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      className="border-t border-pb-line py-16 first:border-t-0 sm:py-20 lg:py-24"
    >
      <div className="grid gap-8 lg:grid-cols-[9rem_minmax(0,1fr)] lg:gap-12">
        <p className="eyebrow lg:sticky lg:top-24 lg:self-start lg:pt-2">{label}</p>

        <div className="min-w-0">
          <h2 className="display max-w-[22ch] text-[clamp(1.65rem,3.2vw,2.35rem)] text-pb-ink">
            {title}
          </h2>
          {lede ? (
            <p className="mt-4 max-w-[62ch] text-[1.0125rem] leading-relaxed text-pb-muted">
              {lede}
            </p>
          ) : null}
          {children ? <div className="mt-9">{children}</div> : null}
        </div>
      </div>
    </section>
  );
}
