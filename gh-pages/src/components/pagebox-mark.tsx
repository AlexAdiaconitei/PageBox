/**
 * The PageBox mark — a globe in an open box.
 *
 * Geometry copied from `src/lib/components/PageboxMark.svelte` in the application, which
 * carries the reasoning: it is built on lucide's own 24×24 grid, stroke only, round joins,
 * `currentColor`, so it sits beside lucide icons without looking like a pasted bitmap and
 * follows the theme with no second file. The globe's interior runs thinner than its
 * outline because at full weight the equator and the meridian close the sphere into a dot.
 *
 * Change it here and change it there. `public/brand/favicon.svg` is the same geometry as a
 * standalone file, copied from `static/favicon.svg`.
 */
export function PageBoxMark({
  className,
  strokeWidth = 1.75,
}: {
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="6.6" r="4.6" />
      <g strokeWidth={strokeWidth * 0.74}>
        <path d="M7.4 6.6h9.2" />
        <path d="M12 2a7 7 0 0 1 1.8 4.6 7 7 0 0 1-1.8 4.6 7 7 0 0 1-1.8-4.6 7 7 0 0 1 1.8-4.6z" />
      </g>
      <path d="M4.2 11.4 1.4 8.2 5.6 6.2" />
      <path d="m19.8 11.4 2.8-3.2-4.2-2" />
      <path d="M4.2 11.4 12 15.6l7.6-4.2" />
      <path d="M4.2 11.4v6l7.8 4.2 7.6-4.2v-6" />
      <path d="M12 15.6v6" />
    </svg>
  );
}
