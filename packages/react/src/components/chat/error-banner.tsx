"use client";

import { useState, useEffect, useMemo } from "react";
import { parseChatError, type AuthMode } from "../../lib/types";

export function ErrorBanner({ error, authMode }: { error: Error; authMode: AuthMode }) {
  const info = useMemo(() => parseChatError(error, authMode), [error, authMode]);
  const [countdown, setCountdown] = useState(info.retryAfterSeconds ?? 0);

  useEffect(() => {
    if (!info.retryAfterSeconds) return;
    setCountdown(info.retryAfterSeconds);
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) { clearInterval(interval); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [info.retryAfterSeconds]);

  const detail = info.retryAfterSeconds && countdown > 0
    ? `Try again in ${countdown} second${countdown !== 1 ? "s" : ""}.`
    : info.detail;

  return (
    <div className="mb-2 rounded-lg border border-red-300 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400 px-4 py-3 text-sm">
      <p className="font-medium">{info.title}</p>
      {detail && <p className="mt-1 text-xs opacity-80">{detail}</p>}
    </div>
  );
}
