/** Tour step definition for the guided onboarding tour. */
export interface TourStep {
  /** Unique identifier for this step. */
  id: string;
  /** Step title shown in the tooltip. */
  title: string;
  /** Step description shown in the tooltip. */
  description: string;
  /** CSS selector for the element to highlight. Null for centered modal steps. */
  targetSelector: string | null;
  /** Preferred side for the popover tooltip. */
  side: "top" | "bottom" | "left" | "right";
  /** Whether this step requires admin role to be shown. */
  adminOnly?: boolean;
}

/** Tour completion status from the API. */
export interface TourStatus {
  tourCompleted: boolean;
  tourCompletedAt: string | null;
}
