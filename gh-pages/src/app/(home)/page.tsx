import Link from 'next/link';
import type { Metadata } from 'next';
import { ArrowRight } from 'lucide-react';

import { Shot } from '@/components/shot';
import { Section } from '@/components/home/section';
import { HostSplit } from '@/components/home/host-split';
import { ResponseMatrix } from '@/components/home/response-matrix';
import { FeatureGrid } from '@/components/home/feature-grid';
import { CopyCommand } from '@/components/home/copy-command';
import { DeploymentLedger } from '@/components/home/deployment-ledger';
import { Licence } from '@/components/home/licence';
import { PageBoxMark } from '@/components/pagebox-mark';
import { appName, example, gitUrl, tagline } from '@/lib/shared';

export const metadata: Metadata = {
  title: `${appName} — self-hosted static hosting with access control`,
  description: tagline,
};

const CURL = `curl -X POST https://${example.admin}/api/v1/sites/${example.slug}/deployments \\
  -H "Authorization: Bearer $PAGEBOX_TOKEN" \\
  -H "Content-Type: application/zip" \\
  --data-binary @dist.zip`;

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-[74rem] px-5 sm:px-8">
      {/* --- hero ------------------------------------------------------------ */}
      <section className="pt-14 pb-16 sm:pt-20 lg:pt-24 lg:pb-20">
        {/* The mark and the name carry the hero now. What used to be the headline reads
            underneath at subtitle size: a first-time visitor needs to know what this is
            called before being told what it does, and the sentence was doing both jobs at
            once at a size that let it wrap over four lines. */}
        <div className="flex items-center gap-3 sm:gap-4">
          <PageBoxMark className="size-11 shrink-0 text-pb-live sm:size-14" strokeWidth={1.6} />
          <h1 className="display text-[clamp(2.6rem,8vw,4.5rem)] leading-none text-pb-ink">
            {appName}
          </h1>
        </div>

        <p className="mt-6 max-w-[52ch] text-[1.0125rem] leading-relaxed text-pb-muted sm:text-[1.075rem]">
          Static hosting you run yourself, with access control that reaches{' '}
          <span className="text-pb-ink">every file</span>. It never builds anything: send a{' '}
          <code className="font-mono text-[0.9em] text-pb-ink">dist/</code>, a zip or a lone{' '}
          <code className="font-mono text-[0.9em] text-pb-ink">index.html</code>, and PageBox
          stores it whole and serves it.
        </p>

        <p className="mt-4 text-[0.85rem] text-pb-muted">
          Free for personal use ·{' '}
          <Link href="#licence" className="font-medium text-pb-live hover:underline">
            organisations need a licence
          </Link>
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/docs/start/quickstart"
            className="inline-flex items-center gap-2 rounded-lg bg-pb-live px-4 py-2.5 text-[0.9rem] font-medium text-pb-live-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pb-live motion-reduce:transition-none"
          >
            Run it in five minutes
            <ArrowRight className="size-4" />
          </Link>

          {/* The first command someone actually runs. `docker compose up -d` was here and
              was not runnable on its own — there is a clone and an .env before it — so a
              pill offering it was offering nothing. */}
          <CopyCommand command={`git clone ${gitUrl}`} label="the clone command" />
        </div>
      </section>

      {/* --- the signature: a deployment is a pointer -------------------------- */}
      <section className="pb-16 sm:pb-20 lg:pb-24">
        <DeploymentLedger />
      </section>

      <Section
        label="Two hosts"
        title="The panel and the sites are never the same origin"
        lede="One address is the console and the API. The other is everything anyone has
          deployed."
      >
        <HostSplit />
      </Section>

      <Section
        label="Deploy"
        title="Drop a folder, or push a zip from CI"
        lede="Both land in the same place. Every build stays listed, which is what makes
          rollback a pointer move rather than a rebuild."
      >
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start lg:gap-10">
          {/* min-w-0: a grid item defaults to min-width:auto, which lets the code block's
              longest line set the column width and push the page sideways on a phone. */}
          <div className="min-w-0">
            <pre className="overflow-x-auto rounded-xl border border-pb-line bg-pb-panel p-4 font-mono text-[0.76rem] leading-relaxed text-pb-ink">
              <code>{CURL}</code>
            </pre>

            <p className="mt-5 text-[0.9rem] leading-relaxed text-pb-muted">
              A preflight reads the HTML before the upload leaves the browser, and names the
              option to change for whatever generator produced it.
            </p>

            <Link
              href="/docs/deploy/base-paths"
              className="mt-4 inline-flex items-center gap-1.5 text-[0.875rem] font-medium text-pb-live hover:underline"
            >
              What each generator does not prefix
              <ArrowRight className="size-3.5" />
            </Link>
          </div>

          <Shot
            name="site-detail"
            alt="A site's page in the panel: the drop area, storage figures, and the deployment history with a live marker and Make live buttons"
            caption="The drop area, and every deployment kept behind the live one."
            sizes="(min-width: 1024px) 620px, 100vw"
          />
        </div>
      </Section>

      <Section
        label="Private sites"
        title="A 403 tells you the site is there"
        lede="Checking only the HTML is obscurity, not privacy. Every file resolves the
          caller's grant, and no answer confirms which private sites exist."
      >
        <ResponseMatrix />

        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          <Shot
            name="users"
            alt="The Users screen: accounts, their roles, who issued them and their storage"
            caption="Accounts are issued, never self-registered."
            sizes="(min-width: 1024px) 520px, 100vw"
          />
          <Shot
            name="audit"
            alt="The Activity screen: deploys, rollbacks, grants, tokens and sign-ins with actor, target and detail"
            caption="Every deploy, grant, token and sign-in — successful or not."
            sizes="(min-width: 1024px) 520px, 100vw"
          />
        </div>
      </Section>

      <Section
        label="The console"
        title="Built for the screens an operator keeps open"
        lede="Dense tables, monospace for anything you would copy, and one accent colour."
      >
        <Shot
          name="sites"
          alt="The Sites screen: six sites with their address, access, storage and when each went live"
          priority
        />

        <div className="mt-10 grid items-start gap-8 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] sm:gap-10">
          <Shot
            name="sites-phone"
            alt="The Sites screen on a phone: the rail becomes a row of tabs and each site becomes a card"
            sizes="(min-width: 640px) 240px, 60vw"
          />
          <div>
            <h3 className="font-display text-[1.15rem] font-semibold tracking-tight text-pb-ink">
              It fits on a phone
            </h3>
            <p className="mt-3 max-w-[48ch] text-[0.9rem] leading-relaxed text-pb-muted">
              The rail becomes tabs and tables become cards. Touch targets grow on coarse
              pointers only, so a mouse keeps the tighter console.
            </p>

            <h3 className="mt-8 font-display text-[1.15rem] font-semibold tracking-tight text-pb-ink">
              Even the 404s are yours
            </h3>
            <p className="mt-3 max-w-[48ch] text-[0.9rem] leading-relaxed text-pb-muted">
              One page for every reason a site can be missing, byte for byte identical — so
              it never becomes an oracle.
            </p>
          </div>
        </div>
      </Section>

      <Section label="Also true" title="The parts that matter once it is running">
        <FeatureGrid
          items={[
            {
              title: 'Cached properly',
              body: 'Hashed assets go out immutable for a year, everything else revalidates. Precompressed .br and .gz siblings are used when offered.',
            },
            {
              title: 'Resolution that matches real builds',
              body: '/about answers about.html, then about/index.html. One setting decides what an unmatched path gets.',
            },
            {
              title: 'History that stays bounded',
              body: 'A retention limit prunes on each upload — never the live deployment, and never quietly.',
            },
            {
              title: 'Storage that adds up',
              body: 'Each admin holds so many bytes across every deployment their sites keep, and quotas cannot sum past the pool.',
            },
            {
              title: 'Tokens that cannot outrank their owner',
              body: 'Scoped to one site, re-resolving their owner’s permission on every call. Revoke the grant and the key is dead.',
            },
            {
              title: 'Boots into a working state',
              body: 'Migrations, bucket and first superadmin on boot. Any failure exits rather than serving half-configured.',
            },
          ]}
        />
      </Section>

      <div id="licence" className="scroll-mt-20">
        <Section
          label="Licence"
          title="Free for you. Licensed for your company."
          lede="The line runs between a person and an organisation, not between public and
            private — so find your own case rather than guess from a licence name."
        >
          <Licence />
        </Section>
      </div>

      {/* --- close ------------------------------------------------------------ */}
      <section className="border-t border-pb-line py-16 sm:py-20 lg:py-24">
        <h2 className="display max-w-[18ch] text-[clamp(1.8rem,4vw,2.75rem)] text-pb-ink">
          Postgres, an S3 bucket, and one container.
        </h2>
        <p className="mt-5 max-w-[52ch] text-[1.0125rem] leading-relaxed text-pb-muted">
          The compose file brings its own Postgres and MinIO. Nothing to provision first.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/docs/start/quickstart"
            className="inline-flex items-center gap-2 rounded-lg bg-pb-live px-4 py-2.5 text-[0.9rem] font-medium text-pb-live-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pb-live motion-reduce:transition-none"
          >
            Start here
            <ArrowRight className="size-4" />
          </Link>
          <Link
            href="/docs/deploy/api"
            className="inline-flex items-center gap-2 rounded-lg border border-pb-line px-4 py-2.5 text-[0.9rem] font-medium text-pb-ink transition-colors hover:bg-pb-raise motion-reduce:transition-none"
          >
            Read the deploy API
          </Link>
        </div>
      </section>
    </main>
  );
}
