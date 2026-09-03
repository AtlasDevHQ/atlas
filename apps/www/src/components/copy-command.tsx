"use client";

import { useState } from "react";

type CopyState = "idle" | "copied" | "failed";

const LABEL: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Select & copy",
};

/**
 * A one-line command rendered as the page's primary call to action: a dark
 * code pane (the brand's fixed terminal surface) with a copy button. Clipboard
 * access can be denied (insecure context, permissions policy), so a failure
 * is reported in the button label rather than swallowed.
 */
export function CopyCommand({ command, className = "" }: { command: string; className?: string }) {
  const [state, setState] = useState<CopyState>("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch (err) {
      console.warn(
        "[copy-command] clipboard write failed:",
        err instanceof Error ? err.message : String(err),
      );
      setState("failed");
    }
  }

  return (
    <div
      className={`flex items-center gap-3 overflow-hidden rounded-lg border border-code-border bg-code-bg pl-4 pr-2 shadow-pane ${className}`}
    >
      <span aria-hidden className="font-mono text-[13px] text-code-muted">$</span>
      <code className="flex-1 select-all overflow-x-auto whitespace-nowrap py-3 font-mono text-[13px] text-code-fg">
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-live="polite"
        className="my-1.5 shrink-0 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-ink transition-colors hover:bg-accent-hover"
      >
        {LABEL[state]}
      </button>
    </div>
  );
}
