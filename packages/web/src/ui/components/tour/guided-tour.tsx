"use client";

import { createContext, useContext, type ReactNode } from "react";
import { TourOverlay } from "./tour-overlay";
import { useTour } from "./use-tour";

interface TourContextValue {
  /** Start or restart the guided tour. */
  startTour: () => void;
  /** Whether the tour is currently active. */
  isActive: boolean;
}

const TourContext = createContext<TourContextValue | null>(null);

/**
 * Access the tour context to trigger a tour replay from any component
 * (e.g. a help menu item).
 */
export function useTourContext(): TourContextValue | null {
  return useContext(TourContext);
}

interface GuidedTourProps {
  /** Atlas API base URL. */
  apiUrl: string;
  /** Whether the API is cross-origin. */
  isCrossOrigin: boolean;
  /** Whether the current user has admin role. */
  isAdmin: boolean;
  /** Whether server-side tracking is available (managed auth + internal DB). */
  serverTrackingEnabled: boolean;
  /** Child components that can trigger tour via context. */
  children: ReactNode;
}

/**
 * Guided tour provider + overlay.
 *
 * Wraps children with a TourContext so any descendant can call `startTour()`
 * to replay the walkthrough (e.g. from a help menu).
 *
 * The tour auto-starts on first visit when the user hasn't completed it.
 * Loaded via `next/dynamic` to avoid bundle impact on the critical path.
 */
export function GuidedTour({
  apiUrl,
  isCrossOrigin,
  isAdmin,
  serverTrackingEnabled,
  children,
}: GuidedTourProps) {
  const tour = useTour({
    apiUrl,
    isCrossOrigin,
    isAdmin,
    serverTrackingEnabled,
  });

  const contextValue: TourContextValue = {
    startTour: tour.start,
    isActive: tour.isActive,
  };

  return (
    <TourContext.Provider value={contextValue}>
      {children}
      {tour.isActive && tour.steps[tour.currentStep] && (
        <TourOverlay
          active={tour.isActive}
          step={tour.steps[tour.currentStep]}
          stepIndex={tour.currentStep}
          totalSteps={tour.totalSteps}
          onNext={tour.next}
          onPrev={tour.prev}
          onSkip={tour.skip}
        />
      )}
    </TourContext.Provider>
  );
}
