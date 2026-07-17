// The standalone shared-dashboard error state. Extracted from `page.tsx` so the
// CTA → href wiring is render-testable without invoking the async page RSC — in
// particular the #4690 acceptance criterion that `login-required` (and only it)
// produces the login redirect back to the shared view, while every other reason
// offers the neutral "Go to Atlas" home link. Copy + which actions to show come
// from `resolveErrorContent` (`error-content.ts`); this component only renders them.

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import type { ErrorContent } from "./error-content";

export function ErrorShell({ token, content }: { token: string; content: ErrorContent }) {
  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-zinc-950 print:bg-white print:text-black">
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 items-center justify-center px-4 focus:outline-none"
      >
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{content.heading}</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">{content.message}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            {content.primaryAction === "login" ? (
              <Link
                href={`/login?redirect=${encodeURIComponent(`/shared/dashboard/${token}`)}`}
                className={buttonVariants()}
              >
                Log in
              </Link>
            ) : (
              <Link href="/" className={buttonVariants()}>Go to Atlas</Link>
            )}
            {content.showTryAgain && (
              <Link
                href={`/shared/dashboard/${token}`}
                className={buttonVariants({ variant: "outline" })}
              >
                Try again
              </Link>
            )}
          </div>
        </div>
      </main>
      <footer className="border-t border-zinc-200 px-4 py-4 text-center dark:border-zinc-800 print:hidden">
        <a
          href="https://www.useatlas.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Powered by Atlas
        </a>
      </footer>
    </div>
  );
}
