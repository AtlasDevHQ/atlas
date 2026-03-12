"use client";

import { useState } from "react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
          setTimeout(() => setState("idle"), 2000);
        } catch (err) {
          console.warn("Clipboard write failed:", err);
          setState("failed");
          setTimeout(() => setState("idle"), 2000);
        }
      }}
      className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-200"
    >
      {state === "copied" ? "Copied!" : state === "failed" ? "Failed" : label}
    </button>
  );
}
