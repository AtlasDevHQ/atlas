// Stamped dates and versions for the legal pages — single source of truth
// for the hero stamp row on each page and the sitemap's lastModified.
// Update here (and only here) when a policy is revised.

export interface LegalStamp {
  effective: string;
  version: string;
  lastUpdated?: string;
}

export const LEGAL_STAMPS: Record<"privacy" | "terms" | "dpa" | "aup", LegalStamp> = {
  // 2026-08-12 (#5163, #5164) — the Knowledge Base / Company Atlas ingest
  // surface is disclosed in privacy §what-we-collect and DPA §processing
  // details; Annex I states the read-from/disclose-to rule and gains the four
  // remaining chat platforms Atlas posts into on Cloud today (Slack was already
  // listed; Google Chat is built but not released, so it joins when it ships —
  // the annex says so explicitly); privacy §Retention gains the
  // connected-source class; the 99.9% availability figure is withdrawn from
  // terms and the plan tables.
  privacy: { effective: "2026-06-19", version: "v3.3", lastUpdated: "2026-08-12" },
  terms: { effective: "2026-06-19", version: "v4.4", lastUpdated: "2026-08-12" },
  dpa: { effective: "2026-05-02", version: "v2.6", lastUpdated: "2026-08-12" },
  aup: { effective: "2026-04-26", version: "v1.0" },
};

export type LegalSlug = keyof typeof LEGAL_STAMPS;

/** Latest of the effective / last-updated stamps — the sitemap's lastModified. */
export function legalLastModified(slug: LegalSlug): Date {
  const { effective, lastUpdated } = LEGAL_STAMPS[slug];
  return new Date(lastUpdated && lastUpdated > effective ? lastUpdated : effective);
}
