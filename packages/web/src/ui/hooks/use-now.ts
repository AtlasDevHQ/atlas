"use client";

import { useEffect, useState } from "react";

/**
 * Re-renders the caller on a fixed cadence and returns the current epoch-ms.
 *
 * Drives "live" relative-time captions (e.g. a dashboard tile's age caption) so
 * they tick from "just now" → "1m ago" → … without any external re-render
 * trigger. The lazy initializer captures `Date.now()` once at mount (not on
 * every render); the interval then advances it and the interval clears on
 * unmount. Captions bucket to minute resolution, so the brief SSR-vs-hydration
 * clock difference resolves to the same string in practice.
 *
 * Default 30s — fine-grained enough for minute-resolution captions while
 * staying cheap even with a few dozen tiles each holding their own tick.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
