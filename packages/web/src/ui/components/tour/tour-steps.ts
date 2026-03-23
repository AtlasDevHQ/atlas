import type { TourStep } from "./types";

/**
 * Default tour steps for the guided onboarding walkthrough.
 *
 * Targets are identified by `data-tour` attributes placed on key UI elements.
 * Steps with `adminOnly: true` are filtered out for non-admin users.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "chat",
    title: "Chat with your data",
    description:
      "Ask questions about your data in natural language. Atlas translates your questions into SQL and returns results instantly.",
    targetSelector: "[data-tour='chat']",
    side: "bottom",
  },
  {
    id: "notebook",
    title: "Notebook",
    description:
      "Build multi-step analyses with cells you can re-run, reorder, and export. Great for deeper exploration.",
    targetSelector: "[data-tour='notebook']",
    side: "bottom",
  },
  {
    id: "admin",
    title: "Admin console",
    description:
      "Manage connections, users, roles, and monitor usage. Configure your workspace settings here.",
    targetSelector: "[data-tour='admin']",
    side: "bottom",
    adminOnly: true,
  },
  {
    id: "semantic",
    title: "Semantic layer",
    description:
      "Your data model lives here \u2014 entities, metrics, and glossary terms. It helps Atlas understand your data accurately.",
    targetSelector: "[data-tour='semantic']",
    side: "bottom",
  },
];
