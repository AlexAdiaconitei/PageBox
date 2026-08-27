'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { SiteTarget } from '@/lib/recipes';
import { example } from '@/lib/shared';

/**
 * The reader's own site, carried across every page.
 *
 * The panel fills each deploy recipe in with the base path of the site you are looking at,
 * which is most of what makes it usable: nobody has to work out whether their tool wants
 * `/s/docs`, `/s/docs/` or the whole URL. Documentation cannot know the site, so it asks
 * once — and every snippet, table cell and inline path on the site updates.
 *
 * Kept in `localStorage` rather than React state so it survives navigation between pages,
 * and read through `useSyncExternalStore` rather than an effect: the server snapshot is the
 * example site, React swaps in the stored one after hydration, and there is no render pass
 * where half the page has been updated and half has not.
 *
 * Storage is a convenience and nothing more. Every read and write is guarded, and the page
 * is correct with the defaults when the store is unavailable — a private window, a browser
 * set to block site data.
 */

type SiteInput = { host: string; slug: string };

const DEFAULTS: SiteInput = { host: example.sites, slug: example.slug };
const STORAGE_KEY = 'pagebox-docs-site-target';

/** Slugs are lowercase, dash-separated and never empty — the panel enforces the same. */
function cleanSlug(slug: string): string {
  const cleaned = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || DEFAULTS.slug;
}

function cleanHost(host: string): string {
  const cleaned = host
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  return cleaned || DEFAULTS.host;
}

/*
 * A module-level store, because `getSnapshot` has to return the *same object* until
 * something actually changes — returning a fresh one each call makes React re-render for
 * ever.
 */
let snapshot: SiteInput = DEFAULTS;
let loaded = false;
const listeners = new Set<() => void>();

function load(): SiteInput {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULTS;
    const parsed = JSON.parse(stored) as Partial<SiteInput>;
    return {
      host: cleanHost(parsed.host ?? DEFAULTS.host),
      slug: cleanSlug(parsed.slug ?? DEFAULTS.slug),
    };
  } catch {
    return DEFAULTS;
  }
}

function getSnapshot(): SiteInput {
  if (!loaded) {
    snapshot = load();
    loaded = true;
  }
  return snapshot;
}

function getServerSnapshot(): SiteInput {
  return DEFAULTS;
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  // Another tab editing the same value. Cheap to support and it keeps two open pages of
  // this site from disagreeing about which slug the recipes are written for.
  const onStorage = (storageEvent: StorageEvent) => {
    if (storageEvent.key !== STORAGE_KEY) return;
    snapshot = load();
    emit();
  };

  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function write(next: SiteInput) {
  snapshot = next;
  loaded = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not being able to remember it is no reason to refuse to use it.
  }
  emit();
}

export type SiteTargetValue = SiteInput & {
  target: SiteTarget;
  setSite: (next: Partial<SiteInput>) => void;
  reset: () => void;
};

export function useSiteTarget(): SiteTargetValue {
  const site = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setSite = useCallback((next: Partial<SiteInput>) => {
    write({
      host: next.host === undefined ? snapshot.host : cleanHost(next.host),
      slug: next.slug === undefined ? snapshot.slug : cleanSlug(next.slug),
    });
  }, []);

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to undo */
    }
    snapshot = DEFAULTS;
    loaded = true;
    emit();
  }, []);

  const basePath = `/s/${site.slug}/`;

  return {
    ...site,
    setSite,
    reset,
    target: { basePath, url: `https://${site.host}${basePath}` },
  };
}
