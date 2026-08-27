import { getPageImageUrl, source } from '@/lib/source';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { OgCard } from '@/lib/og';

export const revalidate = false;

export async function GET(_req: Request, { params }: RouteContext<'/og/docs/[...slug]'>) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  // The section the page sits in — "Deploying", "Per generator" — which is the one piece
  // of context a link preview cannot get from the title alone.
  const section = page.slugs.length > 1 ? page.slugs[0].replace(/-/g, ' ') : 'Documentation';

  return new ImageResponse(
    <OgCard title={page.data.title} description={page.data.description} eyebrow={section} />,
    { width: 1200, height: 630 },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImageUrl(page).segments,
  }));
}
