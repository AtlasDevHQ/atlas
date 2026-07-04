"use client";

import { useCallback, useState } from "react";
import {
  clearFailureOfKind,
  type ChatActionKind,
  type StoredActionFailure,
} from "../components/chat/error-banner";

/**
 * #4297 — the chat surface's failure-banner state machine, extracted from
 * `AtlasChat` (like `useStopHandler`) so the clear-scoping policy is
 * unit-testable without the full chat harness.
 *
 * One failure is stored at a time (the banner surface is single-slot); the
 * POLICY is in which transitions may replace or clear it:
 *
 * - {@link ChatFailuresApi.report report} — a failed action stores its
 *   failure (tagged with its `kind`), replacing whatever banner is up: the
 *   newest failure is the one the user can act on.
 * - {@link ChatFailuresApi.supersede supersede} — a DELIBERATE user attempt
 *   (send, pin, unpin, opening a conversation, "+ New") clears unscoped:
 *   a fresh attempt supersedes whatever banner is up.
 * - {@link ChatFailuresApi.clearKind clearKind} — machine-initiated
 *   (auto-resume start) and implicit (composer edit) clears are scoped to
 *   their own `kind`, so neither can erase an unrelated failure the user
 *   hasn't seen. Identity-preserving on a non-matching kind (React bails
 *   out of the re-render).
 * - {@link ChatFailuresApi.dismiss dismiss} — the banner's explicit ✕.
 *
 * Failures render as a persistent `ActionErrorBanner` — never an
 * auto-dismissing transient (`useTransientNotice` is for informational
 * successes only): successes may whisper; failures must not.
 */
export interface ChatFailuresApi {
  /** The failure the banner renders, or `null` (no banner). */
  failure: StoredActionFailure | null;
  /** Store a failed action's failure — replaces any current banner. */
  report: (failure: StoredActionFailure) => void;
  /** A deliberate user attempt supersedes any banner (unscoped clear). */
  supersede: () => void;
  /**
   * Kind-scoped clear for machine-initiated / implicit paths — clears the
   * banner only when it belongs to `kind`, never an unseen unrelated one.
   */
  clearKind: (kind: ChatActionKind) => void;
  /** The banner's explicit dismiss affordance (unscoped clear). */
  dismiss: () => void;
}

export function useChatFailures(): ChatFailuresApi {
  const [failure, setFailure] = useState<StoredActionFailure | null>(null);
  const report = useCallback((next: StoredActionFailure) => {
    setFailure(next);
  }, []);
  const supersede = useCallback(() => {
    setFailure(null);
  }, []);
  const clearKind = useCallback((kind: ChatActionKind) => {
    setFailure(clearFailureOfKind(kind));
  }, []);
  return { failure, report, supersede, clearKind, dismiss: supersede };
}
