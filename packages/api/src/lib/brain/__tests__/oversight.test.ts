/**
 * Unit coverage for the admin oversight aggregate (#4825, ADR-0036).
 *
 * The claims worth pinning are the ones a green build would otherwise hide, and
 * every one of them is a NEGATIVE — this surface is defined by what it must not
 * do:
 *
 *   - **no content reaches the wire.** Not "the happy path returns numbers" —
 *     that proves nothing. The pin walks the whole serialized payload looking
 *     for the claim text of a fact the reader cannot see, so a future producer
 *     that helpfully attached an SPO fails here rather than at whichever
 *     consumer noticed first.
 *   - **the counts are NOT reader-scoped.** A view that silently agreed with
 *     `/summary` would restore the exact false all-clear the issue recorded, and
 *     would pass any test that only checked the shape. Asserted by inspecting
 *     the emitted SQL: the bucket statement must carry no `visible_to &&`.
 *   - **a discovered audience is never named.** Both halves: the label is null
 *     AND the withheld id does not appear anywhere in the response, including
 *     in the ordering.
 *   - **a configured audience IS named** — otherwise the label rule would be
 *     satisfied by a component that opaque-handled everything, which discloses
 *     nothing and helps nobody.
 *
 * A literal `BrainCandidateReader` stands in for the pool — no `mock.module()`,
 * no singleton mutation. That the emitted SQL runs against the real schema is
 * the `-pg` suites' job.
 */

import { describe, expect, it } from "bun:test";
import {
  OVERSIGHT_BUCKET_MAX,
  classifyToken,
  loadConfiguredChannels,
  loadFactOversight,
  type ConfiguredChannels,
} from "@atlas/api/lib/brain/oversight";
import { BrainReaderUnresolvedError } from "@atlas/api/lib/brain/reader-context";
import type { BrainCandidateReader } from "@atlas/api/lib/brain/candidates";
import type { BrainPrincipalContext } from "@atlas/api/lib/brain/acl";
import {
  SLACK_HISTORY_CATALOG_ID,
  SLACK_HISTORY_SOURCE,
} from "@atlas/api/lib/brain/ingest/slack/config";
import {
  chatChannelAudienceId,
  parseChatChannelAudienceId,
} from "@atlas/api/lib/brain/ingest/grant";
import { BrainFactOversightSchema } from "@useatlas/schemas";

const WS = "ws-oversight-test";
/** The private channel from the 2026-07-26 soak — configured, so nameable. */
const PRIVATE_CHANNEL = "C0PRIVATE1";
/** A channel no install config names — discovered, so it must stay opaque. */
const UNCONFIGURED_CHANNEL = "C0SECRET99";

function ctx(
  partial: Partial<Extract<BrainPrincipalContext, { origin: "authenticated" }>> = {},
): BrainPrincipalContext {
  return {
    origin: "authenticated",
    workspaceId: WS,
    userId: "user-1",
    role: "admin",
    audienceIds: [],
    ...partial,
  };
}

interface BucketRow {
  token: string;
  awaiting_review?: number;
  published?: number;
  retracted?: number;
  provisional?: number;
  in_tension?: number;
}

/**
 * A pool double that dispatches on the statement, and RECORDS every one.
 *
 * Recording matters as much as answering: the load-bearing assertion in this
 * file is about a predicate that must be ABSENT from one statement and present
 * in another, and neither is observable from the return value.
 */
interface ReaderOptions {
  buckets?: BucketRow[];
  totals?: Record<string, number>;
  /** Overrides `totals` entirely — `[]` models a totals aggregate returning no row. */
  totalsRows?: readonly unknown[];
  reviewable?: number;
  distinctTokens?: number;
  configs?: Array<Record<string, unknown> | null>;
  seen?: string[];
  /** Params of the install-config read, recorded for assertion AFTER the call. */
  configParams?: unknown[][];
  configThrows?: boolean;
  bucketsThrow?: boolean;
}

function reader(options: ReaderOptions): BrainCandidateReader {
  return {
    query: async (sql: string, params?: unknown[]) => {
      options.seen?.push(sql);
      if (sql.includes("workspace_plugins")) {
        // RECORDED, not asserted here: `loadConfiguredChannels` wraps this call
        // in try/catch, so an `expect` thrown inside it is swallowed and
        // reported as a read fault — a decorative assertion that can never fail.
        options.configParams?.push(params ?? []);
        if (options.configThrows) throw new Error("install config read failed");
        return { rows: (options.configs ?? []).map((config) => ({ config })) };
      }
      if (sql.includes("COUNT(DISTINCT g.token)")) {
        return { rows: [{ n: options.distinctTokens ?? 0 }] };
      }
      if (sql.includes("unnest(f.visible_to)")) {
        if (options.bucketsThrow) throw new Error("bucket query failed");
        return { rows: options.buckets ?? [] };
      }
      if (sql.includes("COUNT(*)::int AS n")) {
        return { rows: [{ n: options.reviewable ?? 0 }] };
      }
      return {
        rows: options.totalsRows ?? [
          options.totals ?? {
            awaiting_review: 0,
            published: 0,
            retracted: 0,
            provisional: 0,
            in_tension: 0,
          },
        ],
      };
    },
  };
}

function slackConfig(...channels: string[]): Record<string, unknown> {
  return { channels };
}

describe("classifyToken", () => {
  const configured: ConfiguredChannels = new Map([
    [SLACK_HISTORY_SOURCE, new Set([PRIVATE_CHANNEL])],
  ]);

  it("names the intrinsic arms, which identify no channel and no person", () => {
    expect(classifyToken("org", configured)).toEqual({
      kind: "org",
      labelPolicy: "intrinsic",
    });
    expect(classifyToken("role:admin", configured)).toEqual({
      kind: "role",
      labelPolicy: "intrinsic",
    });
  });

  it("names an audience the admin configured", () => {
    const token = `audience:${chatChannelAudienceId(SLACK_HISTORY_SOURCE, PRIVATE_CHANNEL)}`;
    expect(classifyToken(token, configured)).toEqual({
      kind: "audience",
      labelPolicy: "configured",
    });
  });

  it("withholds an audience the admin never configured", () => {
    // THE rule. The install config is the record of what the admin typed; a
    // channel absent from it is one Atlas discovered, and naming it discloses
    // that the channel exists at all — which the counts alone do not.
    const token = `audience:${chatChannelAudienceId(SLACK_HISTORY_SOURCE, UNCONFIGURED_CHANNEL)}`;
    expect(classifyToken(token, configured)).toEqual({
      kind: "audience",
      labelPolicy: "discovered",
    });
  });

  it("withholds an audience in a namespace it cannot parse", () => {
    // The arm M3's sources inherit if nobody makes a decision. Fail-closed by
    // construction rather than by a default somebody has to remember to write.
    expect(classifyToken("audience:directory-sync:group-42", configured)).toEqual({
      kind: "audience",
      labelPolicy: "discovered",
    });
  });

  it("withholds a channel the admin configured under a DIFFERENT source", () => {
    // `audience_id` is namespaced by source precisely because a Slack `C123`
    // and a future Teams `C123` are unrelated. A configured-set lookup that
    // ignored the source would name the Teams channel on the strength of the
    // Slack one.
    const token = `audience:${chatChannelAudienceId("teams", PRIVATE_CHANNEL)}`;
    expect(classifyToken(token, configured)).toEqual({
      kind: "audience",
      labelPolicy: "discovered",
    });
  });

  it("compares channel ids case-SENSITIVELY, which is a live asymmetry", () => {
    // `parseSlackHistoryConfig` upper-cases at parse; `deriveChatChannelGrant`
    // only trims; this compares with `Set.has`. Slack ids are uppercase so the
    // two agree today — this pins WHICH SIDE owns normalisation, so the next
    // source's author finds out here rather than from a workspace where every
    // label silently went opaque.
    const lowercased: ConfiguredChannels = new Map([
      [SLACK_HISTORY_SOURCE, new Set(["c0private1"])],
    ]);
    const token = `audience:${chatChannelAudienceId(SLACK_HISTORY_SOURCE, PRIVATE_CHANNEL)}`;
    expect(classifyToken(token, lowercased).labelPolicy).toBe("discovered");
  });

  it("withholds a user, whom Atlas resolved rather than the admin naming", () => {
    expect(classifyToken("user:usr_abc", configured)).toEqual({
      kind: "user",
      labelPolicy: "discovered",
    });
  });

  it("withholds an out-of-grammar token, which is arbitrary stored text", () => {
    for (const junk of ["everyone", "ROLE:admin", "role:platform_admin", "", "team:eng"]) {
      expect(classifyToken(junk, configured)).toEqual({
        kind: "malformed",
        labelPolicy: "discovered",
      });
    }
  });
});

describe("chat-channel audience id round trip", () => {
  it("parses back what the deriver minted", () => {
    // The parser is what decides whether a label may be shown. If the id format
    // and this inverse ever drift, every audience silently becomes opaque —
    // fail-closed, but for a reason nobody could find. This is the pin.
    const parts = parseChatChannelAudienceId(
      chatChannelAudienceId(SLACK_HISTORY_SOURCE, PRIVATE_CHANNEL),
    );
    expect(parts).toEqual({ source: SLACK_HISTORY_SOURCE, channelId: PRIVATE_CHANNEL });
  });

  it("keeps a colon-bearing vendor id whole rather than truncating it", () => {
    expect(parseChatChannelAudienceId("chat-channel:slack:C1:extra")).toEqual({
      source: "slack",
      channelId: "C1:extra",
    });
  });

  it("returns null for ids outside the chat-channel namespace", () => {
    for (const id of ["directory-sync:g1", "chat-channel:", "chat-channel:slack:", "slack:C1"]) {
      expect(parseChatChannelAudienceId(id)).toBeNull();
    }
  });
});

describe("loadConfiguredChannels", () => {
  it("collects channel ids across every install row for the catalog", async () => {
    const configParams: unknown[][] = [];
    const configured = await loadConfiguredChannels(
      reader({ configs: [slackConfig("C0AAAAAAA"), slackConfig("C0BBBBBBB")], configParams }),
      WS,
    );
    expect(configured.get(SLACK_HISTORY_SOURCE)).toEqual(
      new Set(["C0AAAAAAA", "C0BBBBBBB"]),
    );
    // Asserted OUT here, where a failure is a failure — inside the double it
    // would be caught by the module's own try/catch and reported as a read
    // fault, i.e. it could never fail the test.
    expect(configParams[0]).toEqual([WS, SLACK_HISTORY_CATALOG_ID]);
  });

  it("degrades to naming nothing when the config read fails", async () => {
    // Fail-CLOSED for a disclosure decision: no configured set means every
    // audience is discovered and every label is withheld. A read fault costs
    // legibility, never confidentiality.
    const configured = await loadConfiguredChannels(reader({ configThrows: true }), WS);
    expect(configured.size).toBe(0);
  });

  it("ignores a config it cannot parse rather than trusting it", async () => {
    const configured = await loadConfiguredChannels(
      reader({ configs: [null, { channels: "not-an-array" }, slackConfig("C0AAAAAAA")] }),
      WS,
    );
    expect(configured.get(SLACK_HISTORY_SOURCE)).toEqual(new Set(["C0AAAAAAA"]));
  });
});

describe("loadFactOversight", () => {
  it("counts the workspace, NOT the reader — the whole point of the surface", async () => {
    const seen: string[] = [];
    await loadFactOversight(reader({ seen }), ctx());

    const bucketSql = seen.find((s) => s.includes("unnest(f.visible_to)"));
    const totalsSql = seen.find(
      (s) => s.includes("FROM brain_facts f") && !s.includes("unnest") && !s.includes("COUNT(*)::int AS n"),
    );
    const reviewableSql = seen.find((s) => s.includes("COUNT(*)::int AS n"));

    // If either unscoped statement ever grew the ACL predicate, this view would
    // agree with `/summary` and report a hidden backlog of zero — correct-
    // looking, self-consistent, and the exact defect it exists to end.
    expect(bucketSql).not.toContain("visible_to &&");
    expect(totalsSql).not.toContain("visible_to &&");
    // And the one number that IS the reader's must genuinely be gated, or the
    // delta collapses from the other side.
    expect(reviewableSql).toContain("visible_to &&");
  });

  it("reports the reader-scoped total beside the workspace total", async () => {
    // The 26 / 32 soak reading.
    const result = await loadFactOversight(
      reader({
        totals: {
          awaiting_review: 32,
          published: 40,
          retracted: 2,
          provisional: 3,
          in_tension: 1,
        },
        reviewable: 26,
      }),
      ctx(),
    );
    expect(result.workspaceTotals.awaitingReview).toBe(32);
    expect(result.reviewableAwaitingReview).toBe(26);
  });

  it("names a configured audience and withholds an unconfigured one", async () => {
    const configuredToken = `audience:${chatChannelAudienceId(SLACK_HISTORY_SOURCE, PRIVATE_CHANNEL)}`;
    const discoveredToken = `audience:${chatChannelAudienceId(SLACK_HISTORY_SOURCE, UNCONFIGURED_CHANNEL)}`;
    const result = await loadFactOversight(
      reader({
        configs: [slackConfig(PRIVATE_CHANNEL)],
        buckets: [
          { token: "org", awaiting_review: 26 },
          { token: configuredToken, awaiting_review: 6 },
          { token: discoveredToken, awaiting_review: 4 },
        ],
      }),
      ctx(),
    );

    const named = result.buckets.find(
      (b) => b.labelPolicy !== "discovered" && b.label === configuredToken,
    );
    expect(named?.labelPolicy).toBe("configured");
    expect(named?.awaitingReview).toBe(6);

    // Both halves. A withheld bucket that still leaked the id through `key` —
    // or through the ordering, had the sort fallen back to the token text —
    // would satisfy a naive assertion and disclose the channel anyway.
    const withheld = result.buckets.find((b) => b.labelPolicy === "discovered");
    expect(withheld?.awaitingReview).toBe(4);
    expect(JSON.stringify(result)).not.toContain(UNCONFIGURED_CHANNEL);
  });

  it("holds `discovered ⇒ no label` over EVERY bucket, not one example", async () => {
    // A property, not a `find()`-by-example: the invariant has exactly one
    // enforcement point in the producer, so a spot check on one bucket leaves
    // the other N unpinned.
    const result = await loadFactOversight(
      reader({
        configs: [slackConfig(PRIVATE_CHANNEL)],
        buckets: [
          { token: "org", awaiting_review: 3 },
          { token: "role:admin", awaiting_review: 2 },
          { token: `audience:${chatChannelAudienceId(SLACK_HISTORY_SOURCE, PRIVATE_CHANNEL)}`, awaiting_review: 4 },
          { token: `audience:${chatChannelAudienceId(SLACK_HISTORY_SOURCE, UNCONFIGURED_CHANNEL)}`, awaiting_review: 5 },
          { token: "user:usr_abc", awaiting_review: 6 },
          { token: "everyone", awaiting_review: 7 },
        ],
      }),
      ctx(),
    );

    expect(result.buckets).toHaveLength(6);
    for (const bucket of result.buckets) {
      if (bucket.labelPolicy === "discovered") {
        expect(bucket).not.toHaveProperty("label");
        expect(bucket.key).toMatch(/^discovered-\d+$/);
      } else {
        // The one free-text field, and it must be a grant token rather than
        // arbitrary prose — `key` carries the same value on this arm.
        expect(bucket.label).toMatch(/^(org|role:[a-z_]+|audience:.+|user:.+)$/);
        expect(bucket.key).toBe(bucket.label);
      }
    }
    // `user:` and `malformed` are never nameable, whatever the config says.
    for (const kind of ["user", "malformed"] as const) {
      const bucket = result.buckets.find((b) => b.kind === kind);
      expect(bucket?.labelPolicy).toBe("discovered");
    }
  });

  it("gives every withheld bucket a distinct handle", async () => {
    const tokens = ["user:usr_a", "user:usr_b", "everyone"];
    const result = await loadFactOversight(
      reader({ buckets: tokens.map((token) => ({ token, awaiting_review: 1 })) }),
      ctx(),
    );
    const keys = result.buckets.map((b) => b.key);
    // Colliding handles would merge two audiences into one row in React's eyes
    // and render one of them not at all — an under-report from an oversight
    // surface, which is the failure mode that matters here.
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.startsWith("discovered-"))).toBe(true);
  });

  it("keeps a withheld bucket's handle stable when only the counts move", async () => {
    // The documented reason `orderingKey` hashes instead of reusing the display
    // sort. Swapping it for the count order passes every other test in this
    // file and makes `discovered-2` mean a different audience between two
    // glances at the same screen.
    const tokens = ["user:usr_a", "user:usr_b", "user:usr_c"];
    const first = await loadFactOversight(
      reader({ buckets: tokens.map((token, i) => ({ token, awaiting_review: i + 1 })) }),
      ctx(),
    );
    const second = await loadFactOversight(
      // Same token set, counts reversed.
      reader({ buckets: tokens.map((token, i) => ({ token, awaiting_review: 30 - i })) }),
      ctx(),
    );

    const keysByCount = (r: Awaited<ReturnType<typeof loadFactOversight>>) =>
      r.buckets.map((b) => [b.awaitingReview, b.key] as const);
    // The handle a given AUDIENCE gets must not move. Counts identify the
    // audience here because each token has a distinct one in both runs.
    expect(new Set(first.buckets.map((b) => b.key))).toEqual(
      new Set(second.buckets.map((b) => b.key)),
    );
    expect(keysByCount(first).map(([, k]) => k)).not.toEqual(
      keysByCount(second).map(([, k]) => k),
    );
  });

  it("orders tied withheld buckets by their handle, never by their own text", async () => {
    // `oversight.ts` warns against `a.token.localeCompare(b.token)` because
    // display order is observable and would leak the alphabetical position of
    // an id this surface just refused to print. With the counts tied, that
    // tiebreak is the only thing deciding order — so this is where it shows.
    const result = await loadFactOversight(
      reader({
        buckets: [
          { token: "user:zzz", awaiting_review: 1 },
          { token: "user:aaa", awaiting_review: 1 },
          { token: "user:mmm", awaiting_review: 1 },
        ],
      }),
      ctx(),
    );
    expect(result.buckets.map((b) => b.key)).toEqual([
      "discovered-1",
      "discovered-2",
      "discovered-3",
    ]);
  });

  it("carries no claim, evidence, or author anywhere in the payload", async () => {
    // The no-content pin. Two halves, because either alone is weak: the key-name
    // sweep catches a projection column somebody wired through, and the VALUE
    // sweep catches content smuggled under an innocuous key. The bucket fixtures
    // below are the tokens of facts whose claim text is seeded in the -pg suite;
    // here the check is that no such text could arrive at all.
    const result = await loadFactOversight(
      reader({
        configs: [slackConfig(PRIVATE_CHANNEL)],
        buckets: [
          { token: "org", awaiting_review: 26, published: 40 },
          {
            token: `audience:${chatChannelAudienceId(SLACK_HISTORY_SOURCE, UNCONFIGURED_CHANNEL)}`,
            awaiting_review: 6,
          },
        ],
        totals: { awaiting_review: 32, published: 40 },
        reviewable: 26,
      }),
      ctx(),
    );

    // Parses against the strict wire schema, so an extra key is a failure here
    // and not a silent strip.
    const parsed = BrainFactOversightSchema.parse(result);
    const COUNTERS = ["awaitingReview", "published", "retracted", "provisional", "inTension"];
    for (const bucket of parsed.buckets) {
      // Exhaustive, per arm — a new key on either is a failure rather than
      // something a `toContain` list would have to be updated to notice.
      expect(Object.keys(bucket).toSorted()).toEqual(
        (bucket.labelPolicy === "discovered"
          ? ["key", "kind", "labelPolicy", ...COUNTERS]
          : ["key", "kind", "label", "labelPolicy", ...COUNTERS]
        ).toSorted(),
      );
    }
    for (const forbidden of [
      "subject",
      "predicate",
      "object",
      "provenance",
      "body",
      "episode",
      "actor",
      "sourceActor",
      "locator",
    ]) {
      expect(JSON.stringify(parsed)).not.toContain(forbidden);
    }
  });

  it("reports bucket truncation, and still reports the TRUE audience count", async () => {
    const buckets = Array.from({ length: OVERSIGHT_BUCKET_MAX + 1 }, (_, i) => ({
      token: `user:usr_${i}`,
      awaiting_review: 1,
    }));
    const result = await loadFactOversight(
      reader({
        buckets,
        totals: { awaiting_review: OVERSIGHT_BUCKET_MAX + 1 },
        distinctTokens: OVERSIGHT_BUCKET_MAX + 1,
      }),
      ctx(),
    );
    expect(result.bucketsTruncated).toBe(true);
    expect(result.buckets).toHaveLength(OVERSIGHT_BUCKET_MAX);
    // The totals are per FACT, not a rollup of the buckets, so the top-line
    // disclosure has to survive a clipped breakdown intact.
    expect(result.workspaceTotals.awaitingReview).toBe(OVERSIGHT_BUCKET_MAX + 1);
    // And the cardinality is the REAL one, not `buckets.length` — otherwise the
    // panel prints "across 200 audiences" as a fact.
    expect(result.distinctAudiences).toBe(OVERSIGHT_BUCKET_MAX + 1);
  });

  it("skips the cardinality round trip when nothing was clipped", async () => {
    // `buckets.length` IS the cardinality on the untruncated path, and every
    // workspace would otherwise pay a statement so that a handful never render
    // a wrong number.
    const seen: string[] = [];
    const result = await loadFactOversight(
      reader({ seen, buckets: [{ token: "org", awaiting_review: 1 }] }),
      ctx(),
    );
    expect(result.distinctAudiences).toBe(1);
    expect(seen.some((s) => s.includes("COUNT(DISTINCT g.token)"))).toBe(false);
  });

  it("reports a count disagreement instead of a reassuring delta", async () => {
    // The scoped count cannot exceed the unscoped one at a single instant, but
    // these are separate statements — an ingest between them inverts them. The
    // one thing that must not happen is a silent clamp to zero, which renders
    // as "nothing is hidden from you": #4825's defect, reproduced by its fix.
    const result = await loadFactOversight(
      reader({ totals: { awaiting_review: 5 }, reviewable: 9 }),
      ctx(),
    );
    expect(result.countsConsistent).toBe(false);
    // Both numbers survive intact — neither is clamped into agreeing.
    expect(result.workspaceTotals.awaitingReview).toBe(5);
    expect(result.reviewableAwaitingReview).toBe(9);
  });

  it("reports counts as consistent on the ordinary path", async () => {
    // Non-vacuity for the test above: a producer that hard-coded `false` would
    // otherwise pass it and permanently suppress the real disclosure.
    const result = await loadFactOversight(
      reader({ totals: { awaiting_review: 32 }, reviewable: 26 }),
      ctx(),
    );
    expect(result.countsConsistent).toBe(true);
  });

  it("refuses to serve all-zero totals when the totals row is missing", async () => {
    // An aggregate with no GROUP BY always returns one row, so this is drift —
    // and all-zero would render as a complete, confident "nothing is hidden",
    // which is the one answer this surface must never invent.
    await expect(loadFactOversight(reader({ totalsRows: [] }), ctx())).rejects.toThrow(
      /totals aggregate returned no row/,
    );
  });

  it("propagates a bucket-query failure rather than serving an empty breakdown", async () => {
    // An empty-but-plausible breakdown is indistinguishable from a healthy
    // workspace with no facts. The route turns this into a 500 with a requestId.
    await expect(loadFactOversight(reader({ bucketsThrow: true }), ctx())).rejects.toThrow(
      /bucket query failed/,
    );
  });

  it("refuses a reader whose identity did not resolve", async () => {
    // Serving the workspace's shape to an unidentified session would be the
    // disclosure this surface is otherwise careful about, and the paired
    // reviewable count would be a fabricated zero rendering as "all of it is
    // hidden from you".
    await expect(
      loadFactOversight(reader({}), {
        origin: "unresolved",
        workspaceId: WS,
        userId: null,
        role: null,
        audienceIds: [],
      }),
    ).rejects.toBeInstanceOf(BrainReaderUnresolvedError);
  });
});
