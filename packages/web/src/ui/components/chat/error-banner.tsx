"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { parseChatError, type AuthMode, type ClientErrorCode } from "../../lib/types";
import { WifiOff, ServerCrash, ShieldAlert, Clock, AlertTriangle } from "lucide-react";

/** Icon for each client error code */
function ErrorIcon({ clientCode }: { clientCode?: ClientErrorCode }) {
  switch (clientCode) {
    case "offline":
      return <WifiOff className="size-4 shrink-0" />;
    case "api_unreachable":
      return <ServerCrash className="size-4 shrink-0" />;
    case "auth_failure":
      return <ShieldAlert className="size-4 shrink-0" />;
    case "rate_limited_http":
      return <Clock className="size-4 shrink-0" />;
    case "server_error":
      return <ServerCrash className="size-4 shrink-0" />;
    default:
      return <AlertTriangle className="size-4 shrink-0" />;
  }
}

export function ErrorBanner({
  error,
  authMode,
  onRetry,
}: {
  error: Error;
  authMode: AuthMode;
  onRetry?: () => void;
}) {
  const info = useMemo(() => parseChatError(error, authMode), [error, authMode]);
  const [countdown, setCountdown] = useState(info.retryAfterSeconds ?? 0);
  const [restoredOnline, setRestoredOnline] = useState(false);

  // Countdown timer for rate-limited errors
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

  // Auto-retry when countdown reaches 0 for rate-limited errors
  useEffect(() => {
    if (info.retryAfterSeconds && countdown === 0 && onRetry) {
      onRetry();
    }
  }, [countdown, info.retryAfterSeconds, onRetry]);

  // Offline auto-recovery — listen for online event
  useEffect(() => {
    if (info.clientCode !== "offline") return;

    function handleOnline() {
      setRestoredOnline(true);
      // Auto-retry when coming back online
      onRetry?.();
    }

    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
    };
  }, [info.clientCode, onRetry]);

  // If we were offline but came back online, hide the banner
  if (info.clientCode === "offline" && restoredOnline) {
    return null;
  }

  const detail = info.retryAfterSeconds && countdown > 0
    ? `Try again in ${countdown} second${countdown !== 1 ? "s" : ""}.`
    : info.detail;

  const showRetry = info.retryable && onRetry && countdown === 0 && info.clientCode !== "offline";

  return (
    <div
      className="mb-2 rounded-lg border border-red-300 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400 px-4 py-3 text-sm"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <ErrorIcon clientCode={info.clientCode} />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{info.title}</p>
          {detail && <p className="mt-1 text-xs opacity-80">{detail}</p>}
          {info.requestId && (
            <p className="mt-1 text-xs opacity-60">Request ID: {info.requestId}</p>
          )}
          {showRetry && (
            <Button
              variant="link"
              size="sm"
              onClick={onRetry}
              className="mt-2 h-auto p-0 text-xs font-medium text-red-700 dark:text-red-400"
            >
              Try again
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
