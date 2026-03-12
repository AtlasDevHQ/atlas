"use client";

import Script from "next/script";

declare global {
  interface Window {
    Atlas?: {
      open(): void;
      close(): void;
      toggle(): void;
      ask(question: string): void;
      destroy(): void;
    };
  }
}

/** Loads the Atlas widget script and hides the default bubble (the hero CTA replaces it). */
export function AtlasWidget() {
  return (
    <Script
      src="https://demo.useatlas.dev/widget.js"
      data-api-url="https://demo.useatlas.dev"
      data-theme="dark"
      data-position="bottom-right"
      strategy="lazyOnload"
    />
  );
}

/** CTA button that opens the Atlas widget. Optionally sends a starter question via `Atlas.ask()`. */
export function TryAtlasButton({ className, question, children }: { className?: string; question?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (question) {
          window.Atlas?.ask(question);
        } else {
          window.Atlas?.open();
        }
      }}
    >
      {children}
    </button>
  );
}
