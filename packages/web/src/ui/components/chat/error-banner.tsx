"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { parseChatError, type AuthMode, type ClientErrorCode } from "../../lib/types";
import { WifiOff, ServerCrash, ShieldAlert, Clock, AlertTriangle, MessageSquarePlus, X } from "lucide-react";

/**
 * A failure (or standing error condition) on the chat surface, described for
 * `ActionErrorBanner` — failed actions (send / load / pin / unpin / resume) as
 * well as standing conditions like the transport health warning or the
 * conversation-list fetch error. Unlike the chat-stream `ErrorBanner` below —
 * which parses a wire `Error` via `parseChatError` — these come from call
 * sites that already know the user-facing title, any server-provided
 * detail/request id, and — when retryable — how to re-run the action (#4297).
 */
export interface ChatActionFailure {
  readonly title: string;
  readonly detail?: string;
  readonly requestId?: string;
  /** Re-runs the failed action. Omit when the action isn't retryable. */
  readonly retry?: () => void;
}

/**
 * #4297 — which action produced a failure STORED in chat state (standing
 * conditions like the health warning render directly and never carry a kind).
 * Scopes narrow clears — machine-initiated (auto-resume supersedes only a
 * `"resume"` failure) and implicit (composer edits clear only a `"send"`
 * failure) — so neither can erase an unrelated failure the user hasn't seen.
 * Deliberate user actions clear unscoped: a fresh attempt supersedes whatever
 * banner is up (resume is the exception — its clear seam is shared with
 * auto-resume, so it stays kind-scoped even on a ResumeBanner click).
 */
export type ChatActionKind = "send" | "load" | "pin" | "unpin" | "resume";
export type StoredActionFailure = ChatActionFailure & { readonly kind: ChatActionKind };

/**
 * Functional-updater factory for the kind-scoped clears described on
 * `ChatActionKind`. Identity-preserving on a non-matching kind so React's
 * setState bails out of the re-render.
 */
export function clearFailureOfKind(
  kind: ChatActionKind,
): (failure: StoredActionFailure | null) => StoredActionFailure | null {
  return (failure) => (failure && failure.kind === kind ? null : failure);
}

/**
 * Structured error surface for failed chat actions — the same visual grade as
 * `ErrorBanner` (icon, title, detail, request id, retry) but fed by a
 * `ChatActionFailure` instead of a chat-stream `Error`. The component never
 * auto-dismisses; callers keep it mounted until the failure is retried,
 * superseded, resolved, or dismissed via `onDismiss` (#4297).
 */
export function ActionErrorBanner({
  failure,
  onDismiss,
}: {
  failure: ChatActionFailure;
  /** Renders a dismiss affordance. Omit for standing conditions (e.g. a health warning) that should stay visible. */
  onDismiss?: () => void;
}) {
  return (
    <div
      className="mb-2 rounded-lg border border-red-300 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400 px-4 py-3 text-sm"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{failure.title}</p>
          {failure.detail && <p className="mt-1 text-xs opacity-80">{failure.detail}</p>}
          {failure.requestId && (
            <p className="mt-1 text-xs opacity-60">Request ID: {failure.requestId}</p>
          )}
          {failure.retry && (
            <Button
              variant="link"
              size="sm"
              onClick={failure.retry}
              className="mt-2 h-auto p-0 text-xs font-medium text-red-700 dark:text-red-400"
            >
              Try again
            </Button>
          )}
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="-m-1 rounded-md p-1 text-red-700/70 hover:bg-red-100 hover:text-red-700 dark:text-red-400/70 dark:hover:bg-red-950/40 dark:hover:text-red-400"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

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
  onStartNewConversation,
}: {
  error: Error;
  authMode: AuthMode;
  onRetry?: () => void;
  /**
   * Handler for `conversation_budget_exceeded` (F-77). When the chat
   * server rejects further messages on a conversation that hit the
   * aggregate step ceiling, the banner replaces "Try again" with a
   * "Start a new conversation" CTA — retrying on the same id will keep
   * failing.
   */
  onStartNewConversation?: () => void;
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

  const isBudgetExceeded = info.code === "conversation_budget_exceeded";
  const showRetry =
    info.retryable && onRetry && countdown === 0 && info.clientCode !== "offline" && !isBudgetExceeded;
  const showStartNew = isBudgetExceeded && Boolean(onStartNewConversation);

  return (
    <div
      className="mb-2 rounded-lg border border-red-300 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400 px-4 py-3 text-sm"
      role="alert"
    >
      <div className="flex items-start gap-2">
        {isBudgetExceeded ? (
          <MessageSquarePlus className="size-4 shrink-0" />
        ) : (
          <ErrorIcon clientCode={info.clientCode} />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium">{info.title}</p>
          {detail && <p className="mt-1 text-xs opacity-80">{detail}</p>}
          {info.requestId && (
            <p className="mt-1 text-xs opacity-60">Request ID: {info.requestId}</p>
          )}
          {showStartNew && (
            <Button
              variant="link"
              size="sm"
              onClick={onStartNewConversation}
              className="mt-2 h-auto p-0 text-xs font-medium text-red-700 dark:text-red-400"
            >
              Start a new conversation
            </Button>
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
