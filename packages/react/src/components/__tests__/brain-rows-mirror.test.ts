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
  // `history` (#5461) — the arms and the junk. A row whose history is a string
  // or whose `prior` is a number must project identically in both copies, for
  // the same reason the malformed tiers above are here.
  { tier: "fact", subject: "Series A", predicate: "has target raise of", object: "10M" },
  {
    tier: "fact",
    subject: "Series A",
    predicate: "has target raise of",
    object: "10M",
    history: {
      prior: { visible: true, factId: "f8", object: "8M", validFrom: null, validTo: "2026-08-26" },
      priorCount: 1,
      changedBy: {
        kind: "correction",
        actor: "user:x",
        actorIdentity: { state: "atlas", userId: "x", name: "Dana Okafor", email: null },
        at: "2026-08-26",
      },
      truncated: false,
    },
  },
  { tier: "fact", object: "10M", history: "not an object" },
  { tier: "fact", object: "10M", history: { prior: 7, priorCount: "many" } },
  { tier: "fact", object: "10M", history: { prior: null, priorCount: 0, changedBy: null } },
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

/**
 * The changed-answer copy (#5461, PRD finish condition 5).
 *
 * Asserted on CONTENT, not merely on agreement between the copies. The wording
 * is what the condition is judged on — "can see the previous answer, and who
 * changed it" — so two copies that agree on the wrong sentence are still wrong,
 * and a mirror test that only compared them would not notice.
 *
 * Run against the widget's copy and cross-checked against the web one, so the
 * pin covers both surfaces. Condition 5 says "someone asks a question", and a
 * reader in an embedded widget is that someone.
 */
describe("the changed-answer line", () => {
  const CORRECTION = {
    history: {
      prior: { visible: true, factId: "f8", object: "8M", validFrom: null, validTo: "2026-08-26" },
      priorCount: 1,
      changedBy: {
        kind: "correction",
        actor: "user:x",
        actorIdentity: { state: "atlas", userId: "x", name: "Dana Okafor", email: null },
        at: "2026-08-26",
      },
      truncated: false,
    },
  };

  test("says what the answer used to be, and names the person who changed it", () => {
    const line = widget.toChanged(CORRECTION);
    expect(line).toContain("8M");
    expect(line).toContain("Dana Okafor");
    expect(line).toEqual(web.toChanged(CORRECTION));
  });

  test("is silent for a claim that never changed", () => {
    // Almost every row. A line reading "no earlier version" on 29 rows out of
    // 30 would bury the one that matters.
    for (const raw of [
      {},
      { history: null },
      { history: { prior: null, priorCount: 0, changedBy: null, truncated: false } },
    ]) {
      expect(widget.toChanged(raw)).toBeNull();
      expect(web.toChanged(raw)).toBeNull();
    }
  });

  test("names NOBODY when the publish gate retired the predecessor", () => {
    // The actor on a gate-retired claim is whoever the NEWER claim was
    // extracted from — a person who never touched the old one.
    const raw = {
      history: {
        prior: { visible: true, factId: "f8", object: "8M", validFrom: null, validTo: "2026-08-26" },
        priorCount: 1,
        changedBy: { kind: "promotion", at: "2026-08-26" },
        truncated: false,
      },
    };
    const line = widget.toChanged(raw)!;
    expect(line).toContain("8M");
    expect(line).toContain("newer claim was published");
    expect(line).not.toMatch(/changed by/i);
    expect(line).toEqual(web.toChanged(raw));
  });

  test("says RESTRICTED, never unknown, when the earlier value is withheld", () => {
    // "Unknown" would be a different and false statement about the record.
    const raw = {
      history: {
        prior: { visible: false },
        priorCount: 1,
        changedBy: { kind: "correction", actor: null, actorIdentity: null, at: "2026-08-26" },
        truncated: false,
      },
    };
    const line = widget.toChanged(raw)!;
    expect(line).toContain("restricted");
    expect(line).not.toMatch(/unknown/i);
    expect(line).toEqual(web.toChanged(raw));
  });

  test("never renders a vendor handle where a name goes", () => {
    // `slack:U0AQW6KF2EM` is an id, not a name. Putting it where a name belongs
    // tells a reader they have been told who did this when they have not.
    const raw = {
      history: {
        prior: { visible: true, factId: "f8", object: "8M", validFrom: null, validTo: "2026-08-26" },
        priorCount: 1,
        changedBy: {
          kind: "correction",
          actor: "slack:U0AQW6KF2EM",
          actorIdentity: { state: "opaque", erased: false },
          at: "2026-08-26",
        },
        truncated: false,
      },
    };
    const line = widget.toChanged(raw)!;
    expect(line).not.toContain("U0AQW6KF2EM");
    expect(line).toContain("cannot name");
    expect(line).toEqual(web.toChanged(raw));
  });

  test("dates a directory name, because that name is a snapshot", () => {
    const raw = {
      history: {
        prior: { visible: true, factId: "f8", object: "8M", validFrom: null, validTo: "2026-08-26" },
        priorCount: 1,
        changedBy: {
          kind: "correction",
          actor: "slack:U1",
          actorIdentity: {
            state: "directory",
            displayName: "Dana Okafor",
            realName: null,
            email: null,
            snapshotAt: "2026-04-02",
          },
          at: "2026-08-26",
        },
        truncated: false,
      },
    };
    const line = widget.toChanged(raw)!;
    expect(line).toContain("Dana Okafor");
    expect(line).toMatch(/as of/i);
    expect(line).toEqual(web.toChanged(raw));
  });

  test("says how many times it changed when only the latest is carried", () => {
    const raw = {
      history: {
        prior: { visible: true, factId: "f8", object: "8M", validFrom: null, validTo: "2026-08-26" },
        priorCount: 3,
        changedBy: { kind: "promotion", at: "2026-08-26" },
        truncated: false,
      },
    };
    expect(widget.toChanged(raw)).toContain("3 times");
  });

  test("survives junk rather than taking the card down with it", () => {
    // A projection that throws on a shape surprise is the bug, not a symptom.
    for (const raw of [{ history: "nope" }, { history: { prior: 7 } }, null, "x", 42, []]) {
      expect(() => widget.toChanged(raw)).not.toThrow();
      expect(widget.toChanged(raw)).toEqual(web.toChanged(raw));
    }
  });
});
