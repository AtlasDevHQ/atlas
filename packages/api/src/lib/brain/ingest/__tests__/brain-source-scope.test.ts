/**
 * The STRUCTURAL falsification for #5203 (grill #5200 T3).
 *
 * ## What this file is for, and why a passing sync test would not do
 *
 * #5203's acceptance criterion is not "Slack ingests without a second install".
 * It is: **a test that fails if a Slack chat-platform install can exist while
 * its episode source does not.** The distinction matters because the bug this
 * ticket retires was never a broken code path — every line worked. What failed
 * was a MODEL: the brain's Slack source was dispatched over a knowledge-pillar
 * install that nothing created, so a workspace could have Slack fully connected
 * and the sync cycle would walk zero rows and report a clean pass. Atlas's own
 * Slack sat in that state for four days across three prod regions, every
 * surface green.
 *
 * A test that merely asserts "connecting Slack produces episodes" would pass
 * against a fix and then go quiet forever. It would not fail when someone adds
 * the NEXT chat vendor as a per-install source, which is the same bug wearing a
 * different vendor name. So the falsification is written against the RULE
 * rather than against the instance:
 *
 *     a chat-class brain source may not be dispatched per install.
 *
 * The chat class is exactly the class whose vendors already hold an ADR-0006
 * Chat Platform pillar install. A second, knowledge-pillar install of such a
 * vendor collects no credential and establishes no connection — it can only
 * carry configuration, which means it exists solely to be remembered, and the
 * whole of #5200's evidence is that it is not.
 *
 * The behavioural half — a Slack chat install cannot exist while its episode
 * source does not, exercised against a live schema — is
 * `brain-source-scope-pg.test.ts`.
 *
 * ## Why registration is the enforcement point
 *
 * Because every OTHER surface reports success. The install query succeeds and
 * returns no rows; the cycle counts zero inspected and logs nothing; the sync
 * state row is simply absent, which is indistinguishable from a source that has
 * not synced yet. There is no failure to observe until someone asks why the
 * brain is empty. A registration-time refusal is the only check that fires
 * while the mistake is still free to fix.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  _resetBrainSourceConnectors,
  listBrainSourceCatalogIds,
  listPerWorkspaceBrainSources,
  registerBrainSourceConnector,
  type BrainSourceConnector,
} from "@atlas/api/lib/brain/ingest/types";
import {
  HUMAN_SOURCE,
  OUTLOOK_SOURCE,
  SLACK_SOURCE,
  ZOOM_SOURCE,
  episodeSourceClass,
  type EpisodeSource,
} from "@atlas/api/lib/brain/sources";
import { createSlackHistoryConnector } from "@atlas/api/lib/brain/ingest/slack/connector";
import { SLACK_EPISODE_SYNC_ID } from "@atlas/api/lib/brain/ingest/slack/scope";

const NOOP_CLIENT = () => ({
  fetchEpisodes: async () => ({ episodes: [], highWaterMark: null }),
});

function perInstall(source: EpisodeSource, catalogId = "catalog:fixture"): BrainSourceConnector {
  return {
    catalogId,
    source,
    scope: { kind: "per-install" },
    audience:
      episodeSourceClass(source) === "chat" || source === HUMAN_SOURCE
        ? { kind: "externally-synced" }
        : { kind: "reverified", reverifier: async () => ({ audiences: 0, failed: 0 }) },
    createClient: NOOP_CLIENT,
  } as BrainSourceConnector;
}

afterEach(() => {
  _resetBrainSourceConnectors();
});

describe("#5203 — a chat-class brain source may not be dispatched per install", () => {
  it("REFUSES to register a chat-class source declaring per-install", () => {
    expect(() => registerBrainSourceConnector(perInstall(SLACK_SOURCE))).toThrow(
      /chat-class.*per-workspace/s,
    );
  });

  it("names the cost in the refusal, not just the rule", () => {
    // The message is the whole value of this guard to whoever trips it: they are
    // adding a connector and have no reason to know what happened in M1. A bare
    // "invalid scope" would send them to widen the type rather than to reconsider
    // the model.
    let message = "";
    try {
      registerBrainSourceConnector(perInstall(SLACK_SOURCE));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("Chat Platform pillar install");
    expect(message).toContain("carries no credential");
    expect(message).toContain("#5203");
  });

  it("ACCEPTS a chat-class source declaring per-workspace", () => {
    expect(() =>
      registerBrainSourceConnector({
        catalogId: "catalog:fixture-chat",
        source: SLACK_SOURCE,
        scope: {
          kind: "per-workspace",
          syncId: "fixture-chat",
          listWorkspaces: () => Promise.resolve([]),
        },
        audience: { kind: "externally-synced" },
        createClient: NOOP_CLIENT,
      }),
    ).not.toThrow();
  });

  // ── The rule is about the CLASS, and these two arms are what prove it ──────
  // Without them the guard would pass just as well if it refused every
  // per-install source, or if it keyed on the string "slack". Zoom and Outlook
  // legitimately KEEP their installs: each collects a secret and has no pillar
  // install to inherit a connection from, which is precisely the property the
  // chat class does not share.
  it("leaves the secret-collecting classes on per-install", () => {
    expect(() => registerBrainSourceConnector(perInstall(ZOOM_SOURCE, "catalog:z"))).not.toThrow();
    expect(() =>
      registerBrainSourceConnector(perInstall(OUTLOOK_SOURCE, "catalog:o")),
    ).not.toThrow();
  });

  it("refuses a connector that declares no scope at all", () => {
    // The type says `scope` is required, so this arm is the data lane — a plain
    // object from a plugin, a cast, an older connector. Silently defaulting to
    // per-install is exactly the shape that let this bug exist.
    const { scope: _dropped, ...noScope } = perInstall(HUMAN_SOURCE);
    expect(() => registerBrainSourceConnector(noScope as BrainSourceConnector)).toThrow(
      /no usable dispatch scope/,
    );
  });

  it("refuses a per-workspace source with an empty syncId", () => {
    // `knowledge_sync_state` is keyed `(workspace_id, collection_id)`, so two
    // per-workspace sources sharing an id would overwrite each other's cursor
    // and high-water mark — each reporting green while skipping what the other
    // advanced past.
    expect(() =>
      registerBrainSourceConnector({
        catalogId: "catalog:fixture-chat",
        source: SLACK_SOURCE,
        scope: { kind: "per-workspace", syncId: "", listWorkspaces: () => Promise.resolve([]) },
        audience: { kind: "externally-synced" },
        createClient: NOOP_CLIENT,
      }),
    ).toThrow(/syncId/);
  });

  it("refuses a DUPLICATE syncId across per-workspace sources — the same collision, arriving sideways", () => {
    // Round 2 of #5209 closed the collection↔brain arm of this class (a
    // knowledge collection may not take a per-workspace syncId as its slug);
    // this is the brain↔brain arm. Two sources booking under one
    // collection_id clobber each other's cursor and high-water mark, each
    // reporting green while skipping what the other advanced past.
    registerBrainSourceConnector({
      catalogId: "catalog:fixture-chat",
      source: SLACK_SOURCE,
      scope: {
        kind: "per-workspace",
        syncId: "shared-sync-id",
        listWorkspaces: () => Promise.resolve([]),
      },
      audience: { kind: "externally-synced" },
      createClient: NOOP_CLIENT,
    });
    expect(() =>
      registerBrainSourceConnector({
        catalogId: "catalog:fixture-chat-2",
        source: SLACK_SOURCE,
        scope: {
          kind: "per-workspace",
          syncId: "shared-sync-id",
          listWorkspaces: () => Promise.resolve([]),
        },
        audience: { kind: "externally-synced" },
        createClient: NOOP_CLIENT,
      }),
    ).toThrow(/already claimed/);
  });
});

describe("#5203 — the two dispatch listings are disjoint and complete", () => {
  it("keeps a per-workspace source OUT of the install-walk filter", () => {
    // The load-bearing half. `listBrainSourceCatalogIds` builds the cycle's
    // `WHERE catalog_id = ANY($1)` filter, and a per-workspace source's catalog
    // id matches no install row — so including it would make the query succeed,
    // return nothing, and the cycle report a clean pass having synced nothing.
    // Green on the absence of the thing being looked for: M1's exact shape.
    registerBrainSourceConnector({
      catalogId: "catalog:fixture-chat",
      source: SLACK_SOURCE,
      scope: {
        kind: "per-workspace",
        syncId: "fixture-chat",
        listWorkspaces: () => Promise.resolve([]),
      },
      audience: { kind: "externally-synced" },
      createClient: NOOP_CLIENT,
    });
    registerBrainSourceConnector(perInstall(ZOOM_SOURCE, "catalog:z"));

    // Asserted as EXACT sets rather than with `not.toContain`. A `not.toContain`
    // passes against a filter that returns nothing at all, which would break
    // Zoom's dispatch while certifying Slack's.
    expect(listBrainSourceCatalogIds()).toEqual(["catalog:z"]);
    expect(listPerWorkspaceBrainSources().map((c) => c.catalogId)).toEqual([
      "catalog:fixture-chat",
    ]);
  });
});

describe("#5203 — the real Slack connector", () => {
  it("is per-workspace, and books its sync state under the retired install's slug", () => {
    const connector = createSlackHistoryConnector({
      listWorkspaces: () => Promise.resolve([]),
    });
    expect(connector.scope.kind).toBe("per-workspace");
    // The VALUE matters, not just the kind. `knowledge_sync_state` is keyed on
    // it, and it is deliberately `slack-history` — the retired handler's default
    // install slug — so every workspace that took the default carries its
    // per-channel cursor and high-water mark across the change untouched. A
    // fresh name here would silently make the first post-upgrade cycle a full
    // backfill for every workspace in the fleet.
    expect(connector.scope.kind === "per-workspace" && connector.scope.syncId).toBe(
      SLACK_EPISODE_SYNC_ID,
    );
    expect(SLACK_EPISODE_SYNC_ID).toBe("slack-history");
  });
});
