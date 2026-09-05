/**
 * Pure assertions about the corpus fiction itself — no database.
 *
 * The point of these is that the demo's designed properties are checkable
 * without seeding anything: a corpus that has quietly stopped producing a
 * stale fact, or whose reviewer has drifted into authoring the claim he
 * reviews, is a demo that contradicts the copy written against it.
 */

import { describe, expect, it } from "bun:test";
import { renderOkfDocument } from "@atlas/okf-bundle";
import { DECAY_AGING_AFTER_DAYS, DECAY_STALE_AFTER_DAYS } from "@atlas/api/lib/brain/staleness";
import {
  CORPUS_REFERENCE_DATE,
  CORPUS_REVIEWER,
  CONTRADICTION_CLAIMS,
  DOCUMENTS,
  EPISODES,
  EXPECTED_CLAIMS,
  matchesExpectedClaim,
  PEOPLE,
  type DemoEpisode,
} from "../corpus";

const MS_PER_DAY = 86_400_000;

/** The band an episode's claim lands in, read at the corpus's own anchor date. */
function bandOf(episode: DemoEpisode): "fresh" | "aging" | "stale" {
  const age = Math.floor(
    (new Date(CORPUS_REFERENCE_DATE).getTime() - new Date(episode.occurredAt).getTime()) / MS_PER_DAY,
  );
  if (age >= DECAY_STALE_AFTER_DAYS) return "stale";
  if (age >= DECAY_AGING_AFTER_DAYS) return "aging";
  return "fresh";
}

describe("demo corpus: decay bands", () => {
  // Read at CORPUS_REFERENCE_DATE, never at wall-clock now: episode dates are
  // absolute, so an assertion against `new Date()` would pass today and fail in
  // a month for a reason that has nothing to do with the corpus.
  it("covers all three bands at the reference date", () => {
    const bands = new Set(EPISODES.map(bandOf));
    expect(bands).toContain("stale");
    expect(bands).toContain("aging");
    expect(bands).toContain("fresh");
  });

  it("dates every episode at or before the reference date", () => {
    const anchor = new Date(CORPUS_REFERENCE_DATE).getTime();
    for (const episode of EPISODES) {
      expect(new Date(episode.occurredAt).getTime()).toBeLessThanOrEqual(anchor);
    }
  });
});

describe("demo corpus: the reviewer", () => {
  it("is a real person in the fiction", () => {
    expect(PEOPLE[CORPUS_REVIEWER]).toBeDefined();
  });

  it("authors neither side of the contradiction", () => {
    // The reviewer standing behind a claim he made himself answers "who stood
    // behind this" with the claimant's name — the shape the approval column
    // exists to avoid. Keyed off the corpus text rather than a hand-kept list
    // so moving a message between authors trips this.
    const reviewerName = PEOPLE[CORPUS_REVIEWER].realName;
    const returnWindowEpisodes = EPISODES.filter((e) => e.body.toLowerCase().includes("return window"));
    expect(returnWindowEpisodes.length).toBeGreaterThan(0);
    for (const episode of returnWindowEpisodes) {
      const author =
        episode.kind === "chat" ? episode.author : episode.kind === "transcript" ? episode.host : episode.from;
      expect(PEOPLE[author].realName).not.toBe(reviewerName);
    }
  });

  it("names both sides of the contradiction, so the tension has two claims to hold", () => {
    expect(CONTRADICTION_CLAIMS).toHaveLength(2);
    expect(CONTRADICTION_CLAIMS[0].objectHints).not.toEqual(CONTRADICTION_CLAIMS[1].objectHints);
  });
});

describe("demo corpus: expected claims", () => {
  // Phrasings the live extractor has actually produced on prod. A hint that
  // admits only the fixture's wording reports a published, correct fact as
  // missing (the etl-owner and retention claims both did), so each key is
  // pinned against the wording that was served rather than the one imagined.
  const served = [
    { key: "etl-owner", subject: "Dana Okafor", predicate: "owns", object: "nightly ETL" },
    { key: "event-log-retention", subject: "NovaMart's raw event logs", predicate: "are kept for", object: "90 days" },
    { key: "payment-processor", subject: "NovaMart", predicate: "uses primary payment processor", object: "Stripe" },
  ];

  for (const row of served) {
    it(`admits the live extractor's phrasing for ${row.key}`, () => {
      const claim = EXPECTED_CLAIMS.find((c) => c.key === row.key);
      expect(claim).toBeDefined();
      expect(matchesExpectedClaim(row, claim!)).toBe(true);
    });
  }
});

describe("demo corpus: documents", () => {
  it("carries unique paths", () => {
    const paths = DOCUMENTS.map((d) => d.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("renders every page as OKF with a title and a body", () => {
    for (const doc of DOCUMENTS) {
      const rendered = renderOkfDocument(
        { title: doc.title, description: doc.description, timestamp: doc.timestamp },
        doc.tags,
        doc.body,
      );
      expect(rendered.startsWith("---\ntype: ")).toBe(true);
      expect(rendered).toContain(JSON.stringify(doc.title));
      expect(rendered).toContain(doc.body.split("\n")[0]);
    }
  });

  it("keeps the returns page on 30 days, so the document is a third voice in the disagreement", () => {
    // If this page is ever "corrected" to 14, the contradiction loses the
    // source the all-hands transcript actually names, and the demo stops
    // showing a document disagreeing with a person.
    const returns = DOCUMENTS.find((d) => d.path.includes("returns"));
    expect(returns).toBeDefined();
    expect(returns?.body).toContain("30 days from delivery");
    expect(returns?.body).not.toContain("14 days from delivery");
  });
});
