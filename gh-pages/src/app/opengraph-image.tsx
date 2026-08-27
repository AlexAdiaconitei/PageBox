import { ImageResponse } from 'next/og';
import { OgCard } from '@/lib/og';

// Required by `output: 'export'` — there is no server to generate this on request.
export const dynamic = 'force-static';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'PageBox — static hosting you run yourself';

/** The card for the landing page. Docs pages get their own from `og/docs/[...slug]`. */
export default function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Self-hosted static hosting"
        title="Static hosting you run yourself"
        description="Access control that reaches every file. Deploy a built artifact, keep every deployment whole, and roll back by moving a pointer."
      />
    ),
    size,
  );
}
