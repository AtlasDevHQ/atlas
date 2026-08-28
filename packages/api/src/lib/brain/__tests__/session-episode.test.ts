/**
 * Unit + guard coverage for lazy session-episode materialization (#5486,
 * ADR-0036 §T9 lock 3).
 *
 * Four of the issue's acceptance criteria live here:
 *
 *   - ⭐ LAZY-ONLY: a session becomes a tier-3 episode only at propose-time.
 *     The source scan pins {@link materializeSessionEpisode} (and its SQL) to
 *     the proposal path, so an eager materializer — a chat-turn hook, a
 *     scheduler sweep — fails a test before it ships. Eager per-session
 *     episoding is the thing lock 3 explicitly rejected.
 *   - ⭐ `extracted_at` IS STAMPED AT INSERT, asserted against the statement
 *     itself: the episode never sits on the extraction queue, so the human's
 *     proposal is never re-derived by the LLM extraction fiber as a second,
 *     machine-produced claim.
 *   - ⭐ THE SEED NEVER INTRODUCES `org`: for an authenticated actor,
 *     {@link sessionGrantSeed} yields `org` only when the carried grant
 *     already holds it — the explicit widening. (`unauthenticated-local` is
 *     the documented exception: `[org]` IS that deployment's declared
 *     principal set, per `acl.ts`.)
 *   - ⭐ THE ADR-0020 BOUNDARY HOLDS: `durable-session.ts`, `durable-state.ts`
 *     and `agent-compaction.ts` carry ZERO brain references — the state the
 *     #5468 grill measured, kept that way by the scan at the bottom. The
 *     session is READ to mint an episode; nothing writes back.
 */

import { describe, expect, it, mock } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getRequestContext: () => undefined,
  withRequestContext: <T>(_ctx: unknown, fn: () => T) => fn(),
  redactPaths: [] as string[],
  scrubErrSerializer: (v: unknown) => v,
  scrubLogFormatter: (o: unknown) => o,
  hashShareToken: (t: string) => t,
  setLogLevel: () => true,
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
}));

const {
  CONVERSATION_OWNERSHIP_SQL,
  SESSION_EPISODE_INSERT_SQL,
  SESSION_EPISODE_SELECT_SQL,
  SessionEpisodeNotFoundError,
  materializeSessionEpisode,
  sessionActorGrantToken,
  sessionGrantSeed,
  sessionLocator,
  sessionSourceId,
} = await import("@atlas/api/lib/brain/session-episode");

const AUTHED = {
  origin: "authenticated" as const,
  workspaceId: "ws-1",
  userId: "u-1",
  role: "member" as const,
  audienceIds: [] as readonly string[],
};
const LOCAL = {
  origin: "unauthenticated-local" as const,
  workspaceId: "ws-1",
  userId: null,
  role: null,
  audienceIds: [] as const,
};
const CONVERSATION_ID = "11111111-2222-4333-8444-555555555555";
const AT = new Date("2026-08-28T09:00:00.000Z");

interface Executed {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Statement-transcript executor, dispatching by identity like `proposal.test.ts`. */
function makeTx(options: { owned?: boolean; existing?: { id: string; visible_to: unknown } } = {}) {
  const executed: Executed[] = [];
  const tx = {
    query: async (sql: string, params: unknown[] = []) => {
      executed.push({ sql, params });
      if (sql === CONVERSATION_OWNERSHIP_SQL) {
        return { rows: options.owned === false ? [] : [{ id: CONVERSATION_ID }] };
      }
      if (sql === SESSION_EPISODE_INSERT_SQL) {
        return { rows: options.existing ? [] : [{ id: "sess-ep-1" }] };
      }
      if (sql === SESSION_EPISODE_SELECT_SQL) {
        return { rows: options.existing ? [options.existing] : [] };
      }
      throw new Error(`unexpected statement in the session-episode path:\n${sql}`);
    },
  };
  return { executed, tx };
}

describe("the grant seed (lock 3)", () => {
  it("is the actor plus what the source episode already carried, actor first, deduplicated", () => {
    expect(sessionGrantSeed(AUTHED, [])).toEqual(["user:u-1"]);
    expect(sessionGrantSeed(AUTHED, ["user:u-1", "audience:team-x"])).toEqual([
      "user:u-1",
      "audience:team-x",
    ]);
  });

  it("⭐ never introduces `org` for an authenticated actor", () => {
    // The acceptance criterion: a proposal cannot land at `[org]` without an
    // explicit widening. The seed derivation is the only place the session
    // path's grant is built, and it cannot manufacture the workspace token.
    expect(sessionGrantSeed(AUTHED, [])).not.toContain("org");
    expect(sessionGrantSeed(AUTHED, ["audience:team-x", "user:u-2"])).not.toContain("org");
  });

  it("passes `org` through only when the carried grant already holds it — the explicit widening", () => {
    expect(sessionGrantSeed(AUTHED, ["org"])).toEqual(["user:u-1", "org"]);
  });

  it("drops non-string and empty carried elements", () => {
    // The stored array is legally messier than the grammar (`acl.ts`'s at-rest
    // rules), and `''` overlaps `ARRAY['']` while granting nobody.
    expect(sessionGrantSeed(AUTHED, ["", 7, null, "audience:a"])).toEqual([
      "user:u-1",
      "audience:a",
    ]);
  });

  it("is `[org]` on unauthenticated-local — the deployment's declared principal set, not a silent default", () => {
    expect(sessionActorGrantToken(LOCAL)).toBe("org");
    expect(sessionGrantSeed(LOCAL, [])).toEqual(["org"]);
  });

  it("throws for an unresolved principal rather than granting from nobody", () => {
    const unresolved = {
      origin: "unresolved" as const,
      workspaceId: "ws-1",
      userId: null,
      role: null,
      audienceIds: [] as const,
    };
    expect(() => sessionActorGrantToken(unresolved)).toThrow(/unresolved/);
  });
});

describe("⭐ extracted_at is stamped at insert", () => {
  it("the INSERT itself binds occurred_at and extracted_at from the same parameter", () => {
    // The non-obvious half of the issue: an episode left with
    // `extracted_at IS NULL` sits on the extraction queue, and the fiber that
    // drains it would re-derive the human's own proposal as a second,
    // machine-produced claim. The stamp is IN the statement — no second write,
    // no window in which the row is queued.
    expect(SESSION_EPISODE_INSERT_SQL).toContain("extracted_at");
    expect(SESSION_EPISODE_INSERT_SQL.match(/\$5::timestamptz/g)).toHaveLength(2);
    // …and the column list pairs them: occurred_at near the middle,
    // extracted_at last, exactly like the correction and proposal episodes.
    expect(SESSION_EPISODE_INSERT_SQL).toMatch(/occurred_at, visible_to, extracted_at\)/);
  });
});

describe("by-reference, per T3", () => {
  it("the INSERT stores a locator and a NULL body", () => {
    // 0180's body-XOR-locator CHECK: the conversation already has an
    // authoritative home, and copying its transcript would fork the truth.
    expect(SESSION_EPISODE_INSERT_SQL).toMatch(/NULL,\s*\$4/);
    expect(sessionLocator(CONVERSATION_ID)).toBe(`conversation:${CONVERSATION_ID}`);
    expect(sessionSourceId(CONVERSATION_ID)).toBe(`session:${CONVERSATION_ID}`);
  });

  it("dedupes on 0180's key, the connector ingest path's exact shape", () => {
    expect(SESSION_EPISODE_INSERT_SQL).toContain(
      "ON CONFLICT (workspace_id, source, source_id) DO NOTHING",
    );
  });
});

describe("materialization", () => {
  it("checks ownership FIRST, then mints with the actor's own grant", async () => {
    const { executed, tx } = makeTx();
    const result = await materializeSessionEpisode(tx, {
      workspaceId: "ws-1",
      conversationId: CONVERSATION_ID,
      ctx: AUTHED,
      at: AT,
    });

    expect(executed[0]?.sql).toBe(CONVERSATION_OWNERSHIP_SQL);
    expect(executed[0]?.params).toEqual([CONVERSATION_ID, "ws-1", "u-1"]);
    const insert = executed.find((e) => e.sql === SESSION_EPISODE_INSERT_SQL);
    expect(insert?.params).toEqual([
      "ws-1",
      `session:${CONVERSATION_ID}`,
      "u-1",
      `conversation:${CONVERSATION_ID}`,
      AT.toISOString(),
      JSON.stringify(["user:u-1"]),
    ]);
    expect(result).toEqual({ episodeId: "sess-ep-1", visibleTo: ["user:u-1"], created: true });
  });

  it("reuses the episode a previous propose minted, reading its grant back verbatim", async () => {
    const { executed, tx } = makeTx({
      existing: { id: "sess-ep-0", visible_to: ["user:u-1", "audience:team-x", null] },
    });
    const result = await materializeSessionEpisode(tx, {
      workspaceId: "ws-1",
      conversationId: CONVERSATION_ID,
      ctx: AUTHED,
      at: AT,
    });

    expect(result.created).toBe(false);
    expect(result.episodeId).toBe("sess-ep-0");
    // "What the source episode already carried" is READ, never re-derived —
    // and narrowed to strings, because the driver hands text[] back untyped.
    expect(result.visibleTo).toEqual(["user:u-1", "audience:team-x"]);
    expect(executed.some((e) => e.sql === SESSION_EPISODE_SELECT_SQL)).toBe(true);
  });

  it("refuses a conversation the actor cannot claim, before ANY write", async () => {
    const { executed, tx } = makeTx({ owned: false });
    await expect(
      materializeSessionEpisode(tx, {
        workspaceId: "ws-1",
        conversationId: CONVERSATION_ID,
        ctx: AUTHED,
        at: AT,
      }),
    ).rejects.toBeInstanceOf(SessionEpisodeNotFoundError);
    // The ownership SELECT is the only statement that ran.
    expect(executed.map((e) => e.sql)).toEqual([CONVERSATION_OWNERSHIP_SQL]);
  });

  it("refuses a malformed conversation id before any SQL at all", async () => {
    // `$1::uuid` on garbage is a Postgres cast error — a 500 naming an
    // internal expression — where the honest answer is the same not-found.
    const { executed, tx } = makeTx();
    await expect(
      materializeSessionEpisode(tx, {
        workspaceId: "ws-1",
        conversationId: "not-a-uuid",
        ctx: AUTHED,
        at: AT,
      }),
    ).rejects.toBeInstanceOf(SessionEpisodeNotFoundError);
    expect(executed).toHaveLength(0);
  });

  it("the ownership gate is strict about the workspace and the owner", () => {
    // Three predicates, each load-bearing: strict `org_id` (no legacy-NULL
    // admittance — a brain write must not inherit from a conversation nothing
    // ties to this workspace), live rows only, and the actor's own conversation
    // unless the deployment has declared it has no user ids.
    expect(CONVERSATION_OWNERSHIP_SQL).toContain("org_id = $2");
    expect(CONVERSATION_OWNERSHIP_SQL).not.toContain("org_id IS NULL");
    expect(CONVERSATION_OWNERSHIP_SQL).toContain("deleted_at IS NULL");
    expect(CONVERSATION_OWNERSHIP_SQL).toContain("$3::text IS NULL OR user_id = $3");
  });
});

describe("⭐ lazy-only: nothing outside the propose path materializes a session", () => {
  it("source scan: the materializer and its SQL are referenced only by session-episode.ts and proposal.ts", () => {
    // Lock 3 rejected eager per-session episoding, and this scan is the test
    // the acceptance criterion asks for: an eager caller — a chat-turn hook, a
    // scheduler sweep, an ingest pass — has to reference the function or its
    // statement by name, and any file doing so outside the propose path fails
    // here. Roots and skip rules mirror `correction.test.ts`'s sole-writer
    // scan; test files are excluded (they exercise the path deliberately).
    //
    // KNOWN RESIDUAL, recorded so this is not read as totality: a hand-copied
    // `INSERT INTO brain_episodes … 'session:'` that spells neither identifier
    // evades a name scan. That shape also evades every other guard this repo
    // has for episode writers, and closing it means a structural
    // statement-splitting scan like the tombstone one — worth building the day
    // a second episode-minting module exists to confuse it with.
    const NEEDLE = /\bmaterializeSessionEpisode\b|\bSESSION_EPISODE_INSERT_SQL\b/;
    const ALLOWED = new Set([
      "packages/api/src/lib/brain/session-episode.ts",
      "packages/api/src/lib/brain/proposal.ts",
    ]);

    const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..", "..");
    const REQUIRED_ROOTS = ["packages", "apps", "ee", "plugins"];
    const OPTIONAL_ROOTS = ["examples", "create-atlas", "create-atlas-plugin"];
    const roots = [...REQUIRED_ROOTS, ...OPTIONAL_ROOTS].filter((r) => {
      try {
        return statSync(join(repoRoot, r)).isDirectory();
      } catch {
        // intentionally ignored: an absent optional root is not scannable, and
        // a missing REQUIRED root is caught by the per-root floor below
        return false;
      }
    });
    const SKIP_DIRS = new Set([
      "node_modules",
      "dist",
      ".next",
      ".turbo",
      "coverage",
      "__tests__",
      "__mocks__",
      "__test-utils__",
      "__snapshots__",
    ]);

    const matched: string[] = [];
    const scanned = new Map<string, number>();
    const walk = (root: string, dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        let stat;
        try {
          stat = statSync(path);
        } catch (err) {
          console.debug(
            `session-episode scan: skipping unreadable path ${path}`,
            err instanceof Error ? err.message : String(err),
          );
          continue;
        }
        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(entry)) continue;
          walk(root, path);
          continue;
        }
        if (!/\.(ts|tsx|js)$/.test(entry) || /\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
        scanned.set(root, (scanned.get(root) ?? 0) + 1);
        if (NEEDLE.test(readFileSync(path, "utf8"))) {
          matched.push(path.substring(repoRoot.length + 1));
        }
      }
    };
    for (const root of roots) walk(root, join(repoRoot, root));

    // Coverage first: the assertion below is satisfied by finding LESS, so a
    // renamed root or an over-broad skip rule would be a false green.
    for (const root of REQUIRED_ROOTS) {
      expect([root, (scanned.get(root) ?? 0) > 0]).toEqual([root, true]);
    }
    // Not vacuous: both allowed files really do reference the needle.
    for (const allowed of ALLOWED) {
      expect([allowed, matched.includes(allowed)]).toEqual([allowed, true]);
    }
    expect(matched.filter((path) => !ALLOWED.has(path))).toEqual([]);
  });
});

describe("⭐ the ADR-0020 boundary (lock 2)", () => {
  it("durable-session.ts, durable-state.ts and agent-compaction.ts hold zero brain references", () => {
    // The #5468 grill measured exactly this ("unbuilt, and cleanly so") and
    // #5486's acceptance criteria say a guard should keep it that way: the
    // session is READ to mint an episode — by this module, one direction,
    // by-reference — and nothing brain-shaped crosses back into durable
    // memory. Substring match, case-insensitive, so `lib/brain`,
    // `brain_facts`, `searchBrain` and `BrainAnything` all trip it; the word
    // does not occur incidentally in any of the three today.
    const durableDir = join(import.meta.dir, "..", "..");
    for (const file of ["durable-session.ts", "durable-state.ts", "agent-compaction.ts"]) {
      const source = readFileSync(join(durableDir, file), "utf8");
      const hits = source
        .split("\n")
        .map((line, i) => (/brain/i.test(line) ? `${file}:${i + 1}: ${line.trim()}` : null))
        .filter((hit): hit is string => hit !== null);
      expect(hits).toEqual([]);
    }
  });
});
