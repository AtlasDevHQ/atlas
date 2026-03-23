"use client";

import { useState, useEffect } from "react";
import type { TourStep, TourStatus } from "./types";
import { TOUR_STEPS } from "./tour-steps";

/** Local storage key used as fallback when the API is unavailable. */
const TOUR_STORAGE_KEY = "atlas-tour-completed";

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
  const [isActive, setIsActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusChecked, setStatusChecked] = useState(false);

  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";

  // Filter steps based on user role
  const steps = isAdmin ? TOUR_STEPS : TOUR_STEPS.filter((s) => !s.adminOnly);

  // Check tour completion status on mount
  useEffect(() => {
    if (statusChecked) return;

    async function checkStatus() {
      // Check local storage first for fast path
      try {
        if (localStorage.getItem(TOUR_STORAGE_KEY) === "true") {
          setLoading(false);
          setStatusChecked(true);
          return;
        }
      } catch {
        // intentionally ignored: localStorage unavailable — continue to API check
      }

      if (serverTrackingEnabled) {
        try {
          const res = await fetch(`${apiUrl}/api/v1/onboarding/tour-status`, {
            credentials,
          });
          if (res.ok) {
            const data: TourStatus = await res.json();
            if (data.tourCompleted) {
              // Sync to local storage
              try {
                localStorage.setItem(TOUR_STORAGE_KEY, "true");
              } catch {
                /// intentionally ignored: localStorage may be unavailable in some environments
              }
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

      // Tour not completed — auto-start
      setIsActive(true);
      setCurrentStep(0);
      setLoading(false);
      setStatusChecked(true);
    }

    checkStatus();
  }, [apiUrl, credentials, serverTrackingEnabled, statusChecked]);

  async function markComplete() {
    // Save to local storage immediately
    try {
      localStorage.setItem(TOUR_STORAGE_KEY, "true");
    } catch {
      /// intentionally ignored: localStorage may be unavailable in some environments
    }

    // Save to server
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
      setCurrentStep((s) => s + 1);
    } else {
      // Last step — complete tour
      setIsActive(false);
      markComplete();
    }
  }

  function prev() {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1);
    }
  }

  function skip() {
    setIsActive(false);
    markComplete();
  }

  function start() {
    // Reset local storage for replay
    try {
      localStorage.removeItem(TOUR_STORAGE_KEY);
    } catch {
      /// intentionally ignored: localStorage may be unavailable in some environments
    }

    // Reset server-side status
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

    setCurrentStep(0);
    setStatusChecked(true);
    setIsActive(true);
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
