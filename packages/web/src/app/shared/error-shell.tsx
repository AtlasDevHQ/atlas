// The standalone share-surface error state, shared by the dashboard and
// conversation pages (#4690, #4719). Renders resource-specific copy (an
// {@link ErrorContent} produced by each surface's `error-content.ts`) and the
// CTA that surface resolved — the reason→action decision (`login-required`
// and only it gets the login redirect) lives in each `error-content.ts` and
// its tests, documented on {@link PrimaryAction} below; this component only
// renders it. Client-safe by design — the org-share resolvers (#4718) render
// it browser-side on the auth wall.

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

/** Which primary CTA the error shell offers. */
export type PrimaryAction =
  // Login redirect back to the shared view — ONLY for `login-required`, where the
  // viewer genuinely has no session. Never for `membership-required`.
  | "login"
  // Neutral "Go to Atlas" home link — the safe default for every other reason,
  // including the signed-in wrong-org viewer.
  | "home";

export interface ErrorContent {
  readonly heading: string;
  readonly message: string;
  readonly primaryAction: PrimaryAction;
  /** Whether to also offer the "Try again" outline link — for non-terminal
   *  failures (expired, network-error, server-error), not not-found or the auth wall. */
  readonly showTryAgain: boolean;
}

export function ErrorShell({
  sharePath,
  content,
}: {
  /** The shared view's own path (e.g. `/shared/dashboard/<token>`) — target of
   *  both the login redirect and the "Try again" link. */
  sharePath: string;
  content: ErrorContent;
}) {
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
                href={`/login?redirect=${encodeURIComponent(sharePath)}`}
                className={buttonVariants()}
              >
                Log in
              </Link>
            ) : (
              <Link href="/" className={buttonVariants()}>Go to Atlas</Link>
            )}
            {content.showTryAgain && (
              <Link href={sharePath} className={buttonVariants({ variant: "outline" })}>
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
