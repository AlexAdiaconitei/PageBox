import type { ReactElement } from 'react';

/**
 * The social card, in the console's own colours.
 *
 * Satori renders a subset of CSS and does not resolve custom properties, so the palette is
 * written out here as literal hex — the same values `src/app/global.css` computes from the
 * panel's oklch tokens. Keep them in step by eye; there is no way to share them.
 */
/*
 * The mark, as a data URI rather than inline JSX: Satori paints a narrow subset of SVG, and
 * an <img> is the one path that is definitely exact. Same geometry as
 * src/components/pagebox-mark.tsx, with the stroke written out because there is no
 * currentColor to inherit here.
 */
const MARK = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#eceef2" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="6.6" r="4.6"/><g stroke-width="1.3"><path d="M7.4 6.6h9.2"/><path d="M12 2a7 7 0 0 1 1.8 4.6 7 7 0 0 1-1.8 4.6 7 7 0 0 1-1.8-4.6 7 7 0 0 1 1.8-4.6z"/></g><path d="M4.2 11.4 1.4 8.2 5.6 6.2"/><path d="m19.8 11.4 2.8-3.2-4.2-2"/><path d="M4.2 11.4 12 15.6l7.6-4.2"/><path d="M4.2 11.4v6l7.8 4.2 7.6-4.2v-6"/><path d="M12 15.6v6"/></svg>`,
)}`;

const INK = '#eceef2';
const MUTED = '#a8adb8';
const FAINT = '#767b87';
const PAGE = '#191b20';
const RULE = '#2c2f36';
const LIVE = '#2dd4bf';

export function OgCard({
  title,
  description,
  eyebrow,
}: {
  title: string;
  description?: string;
  eyebrow: string;
}): ReactElement {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: PAGE,
        padding: '72px 80px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            fontSize: 22,
            letterSpacing: 4,
            textTransform: 'uppercase',
            color: FAINT,
          }}
        >
          {eyebrow}
        </div>

        <div
          style={{
            display: 'flex',
            marginTop: 28,
            fontSize: title.length > 42 ? 62 : 76,
            lineHeight: 1.08,
            letterSpacing: -2,
            fontWeight: 600,
            color: INK,
          }}
        >
          {title}
        </div>

        {description ? (
          <div
            style={{
              display: 'flex',
              marginTop: 26,
              maxWidth: 880,
              fontSize: 28,
              lineHeight: 1.4,
              color: MUTED,
            }}
          >
            {description.length > 150 ? `${description.slice(0, 147)}…` : description}
          </div>
        ) : null}
      </div>

      {/* The mark, the name, and the one line that says what this is. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          borderTop: `1px solid ${RULE}`,
          paddingTop: 28,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={MARK} width={46} height={46} alt="" />

        <div style={{ display: 'flex', fontSize: 30, fontWeight: 600, color: INK }}>PageBox</div>

        <div
          style={{
            display: 'flex',
            marginLeft: 'auto',
            alignItems: 'center',
            gap: 12,
            fontSize: 22,
            color: FAINT,
          }}
        >
          {/* The one spot of accent, and where to find the thing. Not a second strapline:
              the title above has already said what this is. */}
          <div style={{ display: 'flex', width: 9, height: 9, borderRadius: 5, background: LIVE }} />
          github.com/AlexAdiaconitei/PageBox
        </div>
      </div>
    </div>
  );
}
