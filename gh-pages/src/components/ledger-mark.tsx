/**
 * Three bars in a box: the deployments a site holds, the top one live.
 *
 * Not the product's mark — that is `PageBoxMark`, the globe in an open box the panel uses.
 * This one was drawn for the docs site before the real one was wired in, and is kept
 * because it says the thing the landing page is about: which build is being served. It is
 * currently unused; reach for it if a page needs a picture of the ledger idea at icon size.
 */
export function LedgerMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <rect
        x="2.5"
        y="2.5"
        width="27"
        height="27"
        rx="6.5"
        stroke="currentColor"
        strokeWidth="2.2"
        opacity="0.3"
      />
      <rect x="8" y="8" width="16" height="3.4" rx="1.7" className="fill-pb-live" />
      <rect x="8" y="14.3" width="16" height="3.4" rx="1.7" fill="currentColor" opacity="0.38" />
      <rect x="8" y="20.6" width="16" height="3.4" rx="1.7" fill="currentColor" opacity="0.2" />
    </svg>
  );
}
