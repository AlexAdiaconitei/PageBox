import { example } from '@/lib/shared';

/**
 * Two hostnames, and the reason they cannot be one.
 *
 * Drawn as two panels either side of a rule because that is literally the property: the
 * panel's origin never hosts somebody else's JavaScript. The rule is the origin boundary,
 * and the line underneath says what happens if you erase it.
 */
export function HostSplit() {
  return (
    <div className="rounded-xl border border-pb-line bg-pb-panel">
      <div className="grid divide-y divide-pb-line md:grid-cols-2 md:divide-x md:divide-y-0">
        <div className="p-5 sm:p-6">
          <p className="eyebrow">Admin host</p>
          <code className="mt-2 block font-mono text-[0.82rem] text-pb-ink">
            {example.admin}/
          </code>
          <p className="mt-3 text-[0.85rem] leading-relaxed text-pb-muted">
            The panel and the API. The one origin that never serves somebody else&rsquo;s code.
          </p>
        </div>

        <div className="p-5 sm:p-6">
          <p className="eyebrow">Sites host</p>
          <code className="mt-2 block font-mono text-[0.82rem] text-pb-ink">
            {example.sites}/s/&lt;slug&gt;/
          </code>
          <p className="mt-3 text-[0.85rem] leading-relaxed text-pb-muted">
            Every deployed site, each under its own slug.
          </p>
        </div>
      </div>

      <p className="border-t border-pb-line bg-pb-rail px-5 py-3.5 text-[0.82rem] leading-relaxed text-pb-muted sm:px-6">
        Set them to the same hostname and the process exits at startup: a shared origin would
        let any hosted page call the admin API with your admin cookie attached.
      </p>
    </div>
  );
}
