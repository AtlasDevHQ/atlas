"use client";

import { useEffect, useState } from "react";
import type { TourStep, TourStatus } from "./types";
import { TOUR_STEPS } from "./tour-steps";
import { useTourStore } from "@/lib/stores/tour-store";

interface UseTourOptions {
  /** Atlas API base URL. */
  apiUrl: string;
  /** Whether the API is cross-origin (determines credentials mode). */
  isCrossOrigin: boolean;
  /** Whether the current user has admin role. */
  isAdmin: boolean;
  /** Whether we should attempt server-side tour tracking. */
  serverTrackingEnabled: boolean;
}

interface UseTourResult {
  /** Whether the tour is currently active/visible. */
  isActive: boolean;
  /** The current step index (0-based). */
  currentStep: number;
  /** Filtered steps for the current user. */
  steps: TourStep[];
  /** Total number of steps. */
  totalSteps: number;
  /** Whether we're still loading tour status. */
  loading: boolean;
  /** Move to the next step or finish the tour. */
  next: () => void;
  /** Go back to the previous step. */
  prev: () => void;
  /** Skip/dismiss the entire tour. */
  skip: () => void;
  /** Start or restart the tour. */
  start: () => void;
}

export function useTour({
  apiUrl,
  isCrossOrigin,
  isAdmin,
  serverTrackingEnabled,
}: UseTourOptions): UseTourResult {
  const completed = useTourStore((s) => s.completed);
  const isActive = useTourStore((s) => s.isActive);
  const currentStep = useTourStore((s) => s.currentStep);
  const setCompleted = useTourStore((s) => s.setCompleted);
  const setActive = useTourStore((s) => s.setActive);
  const setStep = useTourStore((s) => s.setStep);
  const resetStore = useTourStore((s) => s.reset);
  const [loading, setLoading] = useState(true);
  const [statusChecked, setStatusChecked] = useState(false);

  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const steps = isAdmin ? TOUR_STEPS : TOUR_STEPS.filter((s) => !s.adminOnly);

  // Resolve initial status: persisted `completed` short-circuits the API
  // check. Otherwise probe the server (when tracking is enabled) and fall
  // back to auto-starting the tour for users who've never seen it.
  useEffect(() => {
    if (statusChecked) return;

    if (completed) {
      setLoading(false);
      setStatusChecked(true);
      return;
    }

    let cancelled = false;
    async function checkStatus() {
      if (serverTrackingEnabled) {
        try {
          const res = await fetch(`${apiUrl}/api/v1/onboarding/tour-status`, {
            credentials,
          });
          if (res.ok) {
            const data: TourStatus = await res.json();
            if (data.tourCompleted) {
              if (cancelled) return;
              setCompleted(true);
              setLoading(false);
              setStatusChecked(true);
              return;
            }
          }
        } catch (err) {
          console.warn(
            "Failed to check tour status:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (cancelled) return;
      // Tour not completed — auto-start.
      setActive(true);
      setStep(0);
      setLoading(false);
      setStatusChecked(true);
    }

    void checkStatus(); // fire-and-forget: effect kick-off, cleanup guarded by cancelled flag
    return () => {
      cancelled = true;
    };
  }, [
    apiUrl,
    credentials,
    serverTrackingEnabled,
    statusChecked,
    completed,
    setCompleted,
    setActive,
    setStep,
  ]);

  async function markComplete() {
    setCompleted(true);

    if (serverTrackingEnabled) {
      try {
        await fetch(`${apiUrl}/api/v1/onboarding/tour-complete`, {
          method: "POST",
          credentials,
        });
      } catch (err) {
        console.warn(
          "Failed to save tour completion to server:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  function next() {
    if (currentStep < steps.length - 1) {
      setStep(currentStep + 1);
    } else {
      // Last step — complete tour
      setActive(false);
      void markComplete();
    }
  }

  function prev() {
    if (currentStep > 0) setStep(currentStep - 1);
  }

  function skip() {
    setActive(false);
    void markComplete();
  }

  function start() {
    resetStore();

    if (serverTrackingEnabled) {
      fetch(`${apiUrl}/api/v1/onboarding/tour-reset`, {
        method: "POST",
        credentials,
      }).catch((err) => {
        console.warn(
          "Failed to reset tour on server:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    setStatusChecked(true);
  }

  return {
    isActive,
    currentStep,
    steps,
    totalSteps: steps.length,
    loading,
    next,
    prev,
    skip,
    start,
  };
}
