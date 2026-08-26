/**
 * The widget's row projection must BEHAVE like the first-party one (#5451).
 *
 * `trust-tier-mirror.test.ts` pins the vocabulary — tier, label, meaning, rank.
 * Review found that was being credited with more than it covers: the two
 * `search-brain-card` copies were byte-identical for ~180 lines and pinned by
 * nothing, so chip colours, the projection and the card's copy could all drift
 * silently while the vocabulary test stayed green.
 *
 * The projection is now one small pure module per package
 * (`lib/brain-rows.ts`), and this drives BOTH through the same fixtures. It
 * asserts behaviour rather than source text, which is the right contract across
 * a package boundary that genuinely forbids a shared import: the widget is
 * published and cannot reach `@useatlas/schemas`.
 *
 * Reaches across by relative path, which a test may do and the shipped bundle
 * may not. If the import stops resolving, restore the relation — do not delete
 * the test.
 */
import { describe, expect, test } from "bun:test";

import * as web from "../../../../web/src/ui/lib/brain-rows";
import * as widget from "../../lib/brain-rows";
import { TIER_CHIP_CLASS as WEB_CHIPS } from "../../../../web/src/ui/components/chat/tier-badge";
import { TIER_CHIP_CLASS as WIDGET_CHIPS } from "../chat/tier-badge";
import { ANSWER_TRUST_TIERS } from "../../lib/trust-tier";

/**
 * Every shape the projection has an arm for, plus the ones it does not.
 * The malformed entries are the point: an unlabelled row is #5451 itself, so
 * the two copies must agree about the junk as well as the good data.
 */
const FIXTURES: unknown[] = [
  { tier: "fact", subject: "Billing", predicate: "is owned by", object: "Payments" },
  { tier: "fact", subject: "Billing" },
  { tier: "raw-episode", source: "slack", body: "we moved billing", occurredAt: "2026-08-01" },
  { tier: "raw-episode", headline: "we <b>moved</b> billing" },
  { tier: "document", path: "runbooks/billing.md", title: "Billing runbook" },
  { tier: "document" },
  { tier: "episode-raw" },
  { tier: "" },
  { tier: 42 },
  {},
  null,
  undefined,
  "not an object",
  [],
];

const ENVELOPES: (Record<string, unknown> | null)[] = [
  null,
  {},
  { results: FIXTURES },
  { neighbors: FIXTURES },
  { results: FIXTURES, neighbors: FIXTURES },
  { results: "not an array", neighbors: 7 },
];

describe("widget brain-row projection mirror", () => {
  test("`str` agrees on every scalar shape", () => {
    for (const v of ["  x  ", "", "   ", "x", 0, 1, null, undefined, {}, []]) {
      expect(widget.str(v)).toEqual(web.str(v));
    }
  });

  test("`stripHeadlineMarkup` agrees, tags and all", () => {
    for (const v of ["a <b>b</b> c", "<b></b>", "plain", "", null, 5]) {
      expect(widget.stripHeadlineMarkup(v)).toEqual(web.stripHeadlineMarkup(v));
    }
  });

  test("`formatDate` agrees, including on unparseable input", () => {
    for (const v of ["2026-08-01", "2026-08-01T10:00:00Z", "not a date", "", null]) {
      expect(widget.formatDate(v)).toEqual(web.formatDate(v));
    }
  });

  test("`toRow` agrees on every fixture, linked and unlinked", () => {
    for (const raw of FIXTURES) {
      for (const linked of [true, false]) {
        expect(widget.toRow(raw, linked), `toRow(${JSON.stringify(raw)}, ${linked})`).toEqual(
          web.toRow(raw, linked),
        );
      }
    }
  });

  test("`toRows` agrees on every envelope shape", () => {
    for (const envelope of ENVELOPES) {
      expect(widget.toRows(envelope), JSON.stringify(envelope)).toEqual(web.toRows(envelope));
    }
  });

  /**
   * The invariant the cards are built on, asserted against both copies at once:
   * no row is dropped and no row loses its tier. A projection that silently
   * skipped a malformed row would put an unlabelled claim on screen, which is
   * the bug this whole issue is about.
   */
  test("neither copy ever drops a row or emits a non-string tier", () => {
    const envelope = { results: FIXTURES, neighbors: FIXTURES };
    for (const impl of [web, widget]) {
      const rows = impl.toRows(envelope);
      expect(rows).toHaveLength(FIXTURES.length * 2);
      for (const row of rows) expect(typeof row.tier).toBe("string");
    }
  });

  /**
   * ⚠️ The COLOURS, which the vocabulary test cannot see.
   *
   * Colour is the chip's secondary channel — the label is always text — but a
   * tier that is emerald in the app and violet in the embed is one product
   * telling a customer two different things about the same claim's authority.
   * Review found this pair verbatim-identical and pinned by nothing.
   *
   * Keys only: the palettes are allowed to differ (the widget's is its own, and
   * `packages/web` has shadcn tokens the widget does not). What may NOT differ
   * is which tiers get a colour at all — a tier missing here falls back to an
   * unstyled chip, which is how a tier stops being distinguishable.
   */
  test("both chip maps cover exactly the same tiers", () => {
    expect(Object.keys(WIDGET_CHIPS).toSorted()).toEqual(Object.keys(WEB_CHIPS).toSorted());
  });

  test("every tier in the canonical tuple has a chip in BOTH", () => {
    for (const tier of ANSWER_TRUST_TIERS) {
      expect(WEB_CHIPS, `web chip for ${tier}`).toHaveProperty(tier);
      expect(WIDGET_CHIPS, `widget chip for ${tier}`).toHaveProperty(tier);
    }
  });
});
