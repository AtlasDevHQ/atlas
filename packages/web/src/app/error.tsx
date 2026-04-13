"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-zinc-950 p-4 text-zinc-100">
      <h2 className="text-lg font-semibold">An unexpected error occurred</h2>
      <p className="max-w-md text-center text-sm text-zinc-400">
        {error.message || "Please try again or contact your admin if the problem persists."}
      </p>
      {error.digest && (
        <p className="text-xs text-zinc-500">Ref: {error.digest}</p>
      )}
      <button
        onClick={reset}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Try again
      </button>
    </div>
  );
}
