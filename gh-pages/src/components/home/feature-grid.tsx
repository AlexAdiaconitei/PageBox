import type { ReactNode } from 'react';

/**
 * Hairline cells, not cards: a card implies each item is a separate object, and these are
 * facets of one system. The grid rules are the only thing dividing them.
 */
export function FeatureGrid({
  items,
}: {
  items: { title: string; body: ReactNode; href?: string }[];
}) {
  return (
    <div className="grid border-t border-pb-line sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div
          key={item.title}
          className="border-b border-pb-line px-0 py-6 sm:px-6 sm:[&:nth-child(2n+1)]:pl-0 lg:[&:nth-child(2n+1)]:pl-6 lg:[&:nth-child(3n+1)]:pl-0 sm:border-l sm:first:border-l-0 sm:[&:nth-child(2n+1)]:border-l-0 lg:[&:nth-child(2n+1)]:border-l lg:[&:nth-child(3n+1)]:border-l-0"
        >
          <h3 className="font-display text-[1.02rem] font-semibold tracking-tight text-pb-ink">
            {item.title}
          </h3>
          <p className="mt-2 text-[0.875rem] leading-relaxed text-pb-muted">{item.body}</p>
        </div>
      ))}
    </div>
  );
}
