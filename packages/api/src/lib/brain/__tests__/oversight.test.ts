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
function reader(options: {
  buckets?: BucketRow[];
  totals?: Record<string, number>;
  reviewable?: number;
  configs?: Array<Record<string, unknown> | null>;
  seen?: string[];
  configThrows?: boolean;
}): BrainCandidateReader {
  return {
    query: async (sql: string, params?: unknown[]) => {
      options.seen?.push(sql);
      if (sql.includes("workspace_plugins")) {
        if (options.configThrows) throw new Error("install config read failed");
        expect(params?.[1]).toBe(SLACK_HISTORY_CATALOG_ID);
        return { rows: (options.configs ?? []).map((config) => ({ config })) };
      }
      if (sql.includes("unnest(f.visible_to)")) {
        return { rows: options.buckets ?? [] };
      }
      if (sql.includes("COUNT(*)::int AS n")) {
        return { rows: [{ n: options.reviewable ?? 0 }] };
      }
      return {
        rows: [
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
    const configured = await loadConfiguredChannels(
      reader({ configs: [slackConfig("C0AAAAAAA"), slackConfig("C0BBBBBBB")] }),
      WS,
    );
    expect(configured.get(SLACK_HISTORY_SOURCE)).toEqual(
      new Set(["C0AAAAAAA", "C0BBBBBBB"]),
    );
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

    const named = result.buckets.find((b) => b.label === configuredToken);
    expect(named?.labelPolicy).toBe("configured");
    expect(named?.awaitingReview).toBe(6);

    // Both halves. A `label: null` that still leaked the id through `key` — or
    // through the ordering, had the sort fallen back to the token text — would
    // satisfy a naive assertion and disclose the channel anyway.
    const withheld = result.buckets.find((b) => b.labelPolicy === "discovered");
    expect(withheld?.label).toBeNull();
    expect(withheld?.awaitingReview).toBe(4);
    expect(JSON.stringify(result)).not.toContain(UNCONFIGURED_CHANNEL);
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

  it("carries no claim, evidence, or author anywhere in the payload", async () => {
    // The no-content pin, walked over the SERIALIZED response rather than field
    // by field — a field-by-field check only ever covers the fields somebody
    // remembered to enumerate.
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
    for (const bucket of parsed.buckets) {
      expect(Object.keys(bucket).toSorted()).toEqual(
        [
          "awaitingReview",
          "inTension",
          "key",
          "kind",
          "label",
          "labelPolicy",
          "provisional",
          "published",
          "retracted",
        ].toSorted(),
      );
    }
    for (const forbidden of ["subject", "predicate", "object", "provenance", "body", "episode"]) {
      expect(JSON.stringify(parsed)).not.toContain(forbidden);
    }
  });

  it("reports bucket truncation rather than serving a clipped list as complete", async () => {
    const buckets = Array.from({ length: OVERSIGHT_BUCKET_MAX + 1 }, (_, i) => ({
      token: `user:usr_${i}`,
      awaiting_review: 1,
    }));
    const result = await loadFactOversight(
      reader({ buckets, totals: { awaiting_review: OVERSIGHT_BUCKET_MAX + 1 } }),
      ctx(),
    );
    expect(result.bucketsTruncated).toBe(true);
    expect(result.buckets).toHaveLength(OVERSIGHT_BUCKET_MAX);
    // The totals are per FACT, not a rollup of the buckets, so the top-line
    // disclosure has to survive a clipped breakdown intact.
    expect(result.workspaceTotals.awaitingReview).toBe(OVERSIGHT_BUCKET_MAX + 1);
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
