"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseTransientNoticeReturn {
  /** The currently visible notice, or `""` when none. */
  notice: string;
  /** Show `message` for `ms` milliseconds, superseding any prior notice. */
  showNotice: (message: string, ms: number) => void;
}

/**
 * #4297 — the quiet auto-dismissing notice line for genuinely informational
 * transients (pin success / already-pinned). Failures must NOT flow through
 * here — they surface via the persistent `ActionErrorBanner` instead.
 *
 * One dismissal timer at a time: showing a new notice cancels the previous
 * notice's timeout, so a stale timer can't clip a fresh notice early (the bug
 * class the old per-call-site `setTimeout(() => setWarning(""), …)` had).
 * The pending timer is cleared on unmount.
 */
export function useTransientNotice(): UseTransientNoticeReturn {
  const [notice, setNotice] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((message: string, ms: number) => {
    setNotice(message);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setNotice(""), ms);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { notice, showNotice };
}
