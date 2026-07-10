// Stamped dates and versions for the legal pages — single source of truth
// for the hero stamp row on each page and the sitemap's lastModified.
// Update here (and only here) when a policy is revised.

export interface LegalStamp {
  effective: string;
  version: string;
  lastUpdated?: string;
}

export const LEGAL_STAMPS: Record<"privacy" | "terms" | "dpa" | "aup", LegalStamp> = {
  privacy: { effective: "2026-06-19", version: "v3.2", lastUpdated: "2026-07-10" },
  terms: { effective: "2026-06-19", version: "v4.3", lastUpdated: "2026-07-10" },
  dpa: { effective: "2026-05-02", version: "v2.5", lastUpdated: "2026-07-10" },
  aup: { effective: "2026-04-26", version: "v1.0" },
};

export type LegalSlug = keyof typeof LEGAL_STAMPS;

/** Latest of the effective / last-updated stamps — the sitemap's lastModified. */
export function legalLastModified(slug: LegalSlug): Date {
  const { effective, lastUpdated } = LEGAL_STAMPS[slug];
  return new Date(lastUpdated && lastUpdated > effective ? lastUpdated : effective);
}
