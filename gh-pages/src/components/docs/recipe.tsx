'use client';

import { Fragment, useEffect, useState } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { getRecipe, RECIPES } from '@/lib/recipes';
import { useSiteTarget } from './site-target';

/**
 * One generator's answer to "I will be served under a subpath".
 *
 * The snippet is not syntax-highlighted, and that is deliberate twice over: it keeps a
 * megabyte of highlighter out of a static docs bundle, and it leaves exactly one thing on
 * the block wearing a colour — the value that had to be substituted. That value is the
 * only part a reader has to get right, so it is the only part the eye is sent to.
 */

function Snippet({ code, highlight }: { code: string; highlight: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const parts = code.split(highlight);

  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-pb-line bg-pb-page p-4 pr-12 font-mono text-[0.78rem] leading-relaxed text-pb-ink">
        <code>
          {parts.map((part, index) => (
            <Fragment key={index}>
              {index > 0 ? <span className="text-pb-live">{highlight}</span> : null}
              {part}
            </Fragment>
          ))}
        </code>
      </pre>

      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => setCopied(true));
        }}
        className="absolute right-2 top-2 rounded-md border border-pb-line bg-pb-panel p-1.5 text-pb-faint transition-colors hover:text-pb-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pb-live motion-reduce:transition-none"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        <span className="sr-only">{copied ? 'Copied' : 'Copy this snippet'}</span>
      </button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-pb-line-soft px-4 py-3 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
      <p className="eyebrow sm:pt-0.5">{label}</p>
      <div className="text-[0.85rem] leading-relaxed text-pb-muted">{children}</div>
    </div>
  );
}

export function Recipe({ id, compact = false }: { id: string; compact?: boolean }) {
  const recipe = getRecipe(id);
  const { target } = useSiteTarget();
  const value = recipe.value(target);

  return (
    <div className="not-prose my-6 overflow-hidden rounded-xl border border-pb-line bg-pb-panel">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
        <p className="font-display text-[0.98rem] font-semibold tracking-tight text-pb-ink">
          {recipe.label}
        </p>
        {recipe.aka ? (
          <p className="text-[0.78rem] text-pb-faint">and anything built on it — {recipe.aka}</p>
        ) : null}
        <code className="ml-auto font-mono text-[0.75rem] text-pb-faint">{recipe.file}</code>
      </div>

      <div className="px-4 pb-4">
        <Snippet code={recipe.snippet(target)} highlight={value} />
      </div>

      <Row label="Value">
        <code className="font-mono text-[0.9em] text-pb-ink">
          {recipe.option}: {typeof value === 'string' ? `'${value}'` : value}
        </code>
      </Row>

      <Row label="Build">
        <code className="font-mono text-[0.9em] text-pb-ink">{recipe.build}</code>
        <span> — zip the contents of </span>
        <code className="font-mono text-[0.9em] text-pb-ink">{recipe.output}/</code>
      </Row>

      {compact ? null : (
        <>
          <Row label="Prefixed for you">{recipe.handled}</Row>
          {recipe.manual ? (
            <Row label="Yours to wrap">
              {recipe.manual.what}. Use <strong className="font-medium text-pb-ink">{recipe.manual.helper}</strong>.
            </Row>
          ) : null}
        </>
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-pb-line bg-pb-rail px-4 py-3">
        <a
          href={recipe.docs}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[0.8rem] font-medium text-pb-live hover:underline"
        >
          Official documentation for {recipe.option}
          <ArrowUpRight className="size-3.5" />
        </a>
        {recipe.furtherReading?.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[0.8rem] text-pb-muted hover:text-pb-ink hover:underline"
          >
            {link.text}
            <ArrowUpRight className="size-3" />
          </a>
        ))}
      </div>
    </div>
  );
}

/** The whole table, the way the panel shows it: one tab per generator. */
export function RecipeTabs() {
  const [active, setActive] = useState(RECIPES[0].id);

  return (
    <div className="not-prose my-6">
      <div
        role="tablist"
        aria-label="Static site generators"
        className="-mx-1 flex flex-wrap gap-1 border-b border-pb-line pb-2"
      >
        {RECIPES.map((recipe) => (
          <button
            key={recipe.id}
            role="tab"
            type="button"
            aria-selected={active === recipe.id}
            onClick={() => setActive(recipe.id)}
            className={`rounded-md px-2.5 py-1.5 text-[0.82rem] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pb-live motion-reduce:transition-none ${
              active === recipe.id
                ? 'bg-pb-live-soft font-medium text-pb-live'
                : 'text-pb-muted hover:bg-pb-raise hover:text-pb-ink'
            }`}
          >
            {recipe.label}
          </button>
        ))}
      </div>

      <Recipe id={active} />
    </div>
  );
}
