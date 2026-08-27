import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import { TypeTable } from 'fumadocs-ui/components/type-table';

import { Shot } from '@/components/shot';
import { Prefix } from '@/components/docs/prefix';
import { Recipe, RecipeTabs } from '@/components/docs/recipe';
import { SiteTargetField } from '@/components/docs/site-target-field';

/**
 * Registered globally rather than imported per file: every page in this site is written by
 * the same person for the same reader, so a page that opens with six import lines is six
 * lines of noise before the first sentence.
 */
export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Tabs,
    Tab,
    Steps,
    Step,
    Callout,
    Cards,
    Card,
    Accordions,
    Accordion,
    Files,
    Folder,
    File,
    TypeTable,
    Shot,
    Prefix,
    Recipe,
    RecipeTabs,
    SiteTargetField,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
