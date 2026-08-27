'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** A command you are meant to run, with the one affordance that saves retyping it. */
export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(command).then(() => setCopied(true));
      }}
      className="group inline-flex max-w-full items-center gap-2.5 rounded-lg border border-pb-line bg-pb-panel py-2 pl-3 pr-2.5 text-left transition-colors hover:border-pb-live/60 hover:bg-pb-raise focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pb-live motion-reduce:transition-none"
    >
      <span aria-hidden="true" className="select-none font-mono text-[0.78rem] text-pb-faint">
        $
      </span>
      {/* Wraps rather than truncates: a command cut off mid-URL reads as a mistake, and the
          reader cannot tell what the copy button is about to give them. */}
      <code className="min-w-0 break-all font-mono text-[0.78rem] text-pb-ink">{command}</code>
      <span className="ml-1 shrink-0 text-pb-faint transition-colors group-hover:text-pb-live motion-reduce:transition-none">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </span>
      <span className="sr-only">
        {copied ? 'Copied' : `Copy ${label ?? 'this command'} to the clipboard`}
      </span>
    </button>
  );
}
