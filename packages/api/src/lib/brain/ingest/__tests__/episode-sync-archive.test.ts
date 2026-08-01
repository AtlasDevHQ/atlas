/**
 * "The engine's subtractive-archive path is provably untouched for episodes"
 * (#4770 acceptance criterion), plus the seam registration rules.
 *
 * The claim is STRUCTURAL, so the test is too. A behavioural test ("we called
 * the engine with `archiveAbsent: false`") would prove the opposite of what is
 * wanted — it would prove the archive path is a flag away. What is wanted is
 * that the brain arm cannot reach it at all:
 *
 *   - nothing under `lib/brain/ingest/` imports `ingest-bundle` (which owns
 *     `ingestDocuments`, `archiveAbsent`, and upsert-by-path);
 *   - nothing under `lib/brain/ingest/` names `archiveAbsent` or writes an
 *     UPDATE/DELETE against `brain_episodes`;
 *   - the ONE write is `ON CONFLICT … DO NOTHING`.
 *
 * Source-text pins are the same instrument `connector-sync.test.ts` uses to
 * pin "no publish path exists here", for the same reason: a future refactor
 * that reintroduces the coupling has to delete a test that says why it
 * shouldn't.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { INSERT_EPISODES_SQL } from "@atlas/api/lib/brain/ingest/episodes";
import {
  _resetBrainSourceConnectors,
  findBrainSourceConnectors,
  getBrainSourceConnector,
  listBrainSourceCatalogIds,
  registerBrainSourceConnector,
  type BrainSourceConnector,
} from "@atlas/api/lib/brain/ingest/types";
import {
  CHAT_CLASS,
  HUMAN_SOURCE,
  SLACK_SOURCE,
  WAREHOUSE_CLASS,
  WAREHOUSE_SOURCE,
  type EpisodeSource,
  type EpisodeSourceVendor,
} from "@atlas/api/lib/brain/sources";

const INGEST_DIR = join(import.meta.dir, "..");

/**
 * Strip comments before matching.
 *
 * These modules explain AT LENGTH why they don't archive and don't call
 * `ingestDocuments` — that prose is the point, and a guard that tripped on it
 * would force the explanation to be deleted to stay green, which is exactly
 * backwards. The rule is about CODE, so the scan reads code.
 */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every non-test source file under `lib/brain/ingest/`, recursively. */
function ingestSources(dir: string = INGEST_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...ingestSources(full));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("the episode path cannot reach the engine's archive/upsert half", () => {
  const sources = ingestSources();

  it("finds the modules it is meant to be guarding (the guard is not vacuous)", () => {
    // A recursion or path bug that returned [] would make every assertion
    // below pass while checking nothing.
    const names = sources.map((f) => f.replace(`${INGEST_DIR}/`, ""));
    expect(names).toContain("episodes.ts");
    expect(names).toContain("episode-sync.ts");
    expect(names).toContain("slack/client.ts");
    expect(sources.length).toBeGreaterThanOrEqual(6);
  });

  it("never imports the document ingest seam that owns archiveAbsent", () => {
    for (const file of sources) {
      const text = codeOf(file);
      expect({ file, hit: /from\s+["'][^"']*ingest-bundle["']/.test(text) }).toEqual({
        file,
        hit: false,
      });
      expect({ file, hit: text.includes("ingestDocuments") }).toEqual({ file, hit: false });
    }
  });

  it("never names archiveAbsent at all", () => {
    for (const file of sources) {
      expect({ file, hit: codeOf(file).includes("archiveAbsent") }).toEqual({
        file,
        hit: false,
      });
    }
  });

  it("never issues an UPDATE or DELETE against brain_episodes", () => {
    // Append-only is the point, not an optimization: evidence that can be
    // edited after the fact cannot back a provenance claim (migration 0180).
    for (const file of sources) {
      const text = codeOf(file);
      expect({ file, hit: /UPDATE\s+brain_episodes/i.test(text) }).toEqual({ file, hit: false });
      expect({ file, hit: /DELETE\s+FROM\s+brain_episodes/i.test(text) }).toEqual({
        file,
        hit: false,
      });
    }
  });

  it("writes with DO NOTHING — not DO UPDATE", () => {
    expect(INSERT_EPISODES_SQL).toContain(
      "ON CONFLICT (workspace_id, source, source_id) DO NOTHING",
    );
    expect(INSERT_EPISODES_SQL).not.toContain("DO UPDATE");
  });

  it("never writes extracted_at — the extraction queue stays #4771's", () => {
    expect(INSERT_EPISODES_SQL).not.toContain("extracted_at");
  });

  it("never writes a status column — episodes are evidence, not review-gated", () => {
    // `brain_episodes` is deliberately NOT content-mode registered (#4769); a
    // status write here would be staging evidence as a draft.
    expect(INSERT_EPISODES_SQL).not.toContain("status");
  });
});

describe("the brain source registry", () => {
  // Same reason as the sibling describe below: these mutate the registry module
  // singleton, and a throwing assertion would otherwise leave it dirty.
  afterEach(_resetBrainSourceConnectors);

  // The fixture's SOURCE KIND is a real vocabulary member
  // (`lib/brain/sources.ts`) while its CATALOG ID stays fixture-shaped — the
  // two are independent, which is the point: one kind can back many catalog
  // rows. A made-up kind here would no longer register (see the vocabulary
  // test below).
  function connector(overrides: Partial<BrainSourceConnector> = {}): BrainSourceConnector {
    return {
      catalogId: "catalog:fixture",
      source: SLACK_SOURCE,
      createClient: () => ({ fetchEpisodes: async () => ({ episodes: [], highWaterMark: null }) }),
      ...overrides,
    };
  }

  it("registers, resolves, and lists a source", () => {
    _resetBrainSourceConnectors();
    registerBrainSourceConnector(connector());
    expect(getBrainSourceConnector("catalog:fixture")?.source).toBe(SLACK_SOURCE);
    expect(listBrainSourceCatalogIds()).toEqual(["catalog:fixture"]);
    _resetBrainSourceConnectors();
  });

  it("refuses a duplicate catalog id rather than shadowing an install", () => {
    _resetBrainSourceConnectors();
    registerBrainSourceConnector(connector());
    expect(() => registerBrainSourceConnector(connector())).toThrow(/already registered/);
    _resetBrainSourceConnectors();
  });

  // `source` is typed `EpisodeSource`, so these values cannot be written
  // without a cast — which is exactly the compile-time half of the gate. The
  // casts below stand in for the producer the type CANNOT reach: a plugin,
  // compiled separately, whose connector arrives here as data.
  const asClass = (value: string) => value as EpisodeSource;

  it("refuses a malformed source slug — it is stored verbatim in the table", () => {
    _resetBrainSourceConnectors();
    expect(() =>
      registerBrainSourceConnector(connector({ source: asClass("Slack History") })),
    ).toThrow(/invalid/);
    expect(() => registerBrainSourceConnector(connector({ source: asClass("") }))).toThrow(
      /invalid/,
    );
    _resetBrainSourceConnectors();
  });

  it("refuses a well-formed slug that is not in the episode-source vocabulary", () => {
    // The regression this exists for: a future warehouse producer naming its
    // kind after the VENDOR. `snowflake` is a perfectly legal slug, so
    // the pattern check above waves it through — and `isWarehouseDerived`
    // would then never match it, so tier-1 correction refusal would fail OPEN
    // with every existing test still green. Registration is where that has to
    // stop, because nothing downstream can tell a novel class from a typo.
    _resetBrainSourceConnectors();
    for (const vendor of ["snowflake", "bigquery", "warehouse-prod", "fixture"]) {
      expect(() => registerBrainSourceConnector(connector({ source: asClass(vendor) }))).toThrow(
        /not in the episode-source vocabulary/,
      );
    }
    // The ACTIONABLE half, not just the recognisable prefix. `not in the
    // episode-source vocabulary` matched the OLD message too, so on its own it
    // would let the string rot straight back to the retired "it must BE
    // warehouse" wording — the exact comment-rot class this seam keeps fixing.
    // This is what a plugin author actually reads, so pin what it tells them.
    expect(() => registerBrainSourceConnector(connector({ source: asClass("snowflake") }))).toThrow(
      /EPISODE_SOURCE_SPECS/,
    );
    expect(() => registerBrainSourceConnector(connector({ source: asClass("snowflake") }))).toThrow(
      /MUST declare class: "warehouse"/,
    );
    // …and a real member still registers, so the rule is a vocabulary check
    // and not a blanket refusal.
    expect(() => registerBrainSourceConnector(connector({ source: WAREHOUSE_SOURCE }))).not.toThrow();
    _resetBrainSourceConnectors();
  });
});

describe("resolving connectors by class + vendor (#4963)", () => {
  // `afterEach`, not a trailing statement per test: these mutate the registry
  // module singleton, and a throwing assertion would skip an inline reset and
  // cascade a `already registered` failure into the next test.
  afterEach(_resetBrainSourceConnectors);

  /**
   * FOUR connectors spanning both grains: TWO vendor-grained chat ones and two
   * class-grained ones with no vendor at all. `catalog:chat-b` deliberately
   * shares `catalog:chat-a`'s class AND vendor — nothing bounds a class+vendor
   * pair to one catalog row, and the lookup must not quietly behave as if
   * something did. That pair is what the `toHaveLength(2)` test below rests on.
   */
  function seedRegistry(): void {
    const make = (catalogId: string, source: EpisodeSource): BrainSourceConnector => ({
      catalogId,
      source,
      createClient: () => ({ fetchEpisodes: async () => ({ episodes: [], highWaterMark: null }) }),
    });
    registerBrainSourceConnector(make("catalog:chat-a", SLACK_SOURCE));
    registerBrainSourceConnector(make("catalog:chat-b", SLACK_SOURCE));
    registerBrainSourceConnector(make("catalog:wh", WAREHOUSE_SOURCE));
    registerBrainSourceConnector(make("catalog:human", HUMAN_SOURCE));
  }

  const ids = (found: readonly BrainSourceConnector[]) => found.map((c) => c.catalogId).toSorted();

  it("resolves by class, by vendor, and by both together", () => {
    seedRegistry();
    expect(ids(findBrainSourceConnectors({ sourceClass: CHAT_CLASS }))).toEqual([
      "catalog:chat-a",
      "catalog:chat-b",
    ]);
    expect(ids(findBrainSourceConnectors({ vendor: "slack" }))).toEqual([
      "catalog:chat-a",
      "catalog:chat-b",
    ]);
    expect(ids(findBrainSourceConnectors({ sourceClass: CHAT_CLASS, vendor: "slack" }))).toEqual([
      "catalog:chat-a",
      "catalog:chat-b",
    ]);
    expect(ids(findBrainSourceConnectors({ sourceClass: WAREHOUSE_CLASS }))).toEqual([
      "catalog:wh",
    ]);
  });

  it("returns EVERY connector sharing a class+vendor, not the first", () => {
    // The registry is keyed by catalog id, so two catalog rows can legitimately
    // serve one vendor (Slack history and a later Slack-canvases source). A
    // lookup that returned a single connector would silently drop one of them,
    // and the M3 webhook fast-path — the caller this exists for — would deliver
    // events to whichever registered first.
    seedRegistry();
    expect(findBrainSourceConnectors({ sourceClass: CHAT_CLASS, vendor: "slack" })).toHaveLength(2);
  });

  it("an empty query does not constrain, and is the same as no argument", () => {
    // The vendorless sources are reachable via the CLASS axis rather than a
    // `vendor: null` state — see `BrainSourceConnectorQuery.vendor` for why
    // that third state was refused (this repo has `exactOptionalPropertyTypes`
    // off, so a caller's `{ vendor: maybeUndefined }` would silently widen a
    // tri-state filter back to "match everything").
    seedRegistry();
    expect(ids(findBrainSourceConnectors({}))).toEqual([
      "catalog:chat-a",
      "catalog:chat-b",
      "catalog:human",
      "catalog:wh",
    ]);
    expect(ids(findBrainSourceConnectors())).toEqual(ids(findBrainSourceConnectors({})));
    // And an EXPLICIT undefined behaves as absence, not as a filter — the
    // shape a caller plucking an optional field actually produces.
    expect(ids(findBrainSourceConnectors({ vendor: undefined, sourceClass: undefined }))).toEqual(
      ids(findBrainSourceConnectors()),
    );
    // The vendorless set, asked the way the type permits.
    expect(ids(findBrainSourceConnectors({ sourceClass: WAREHOUSE_CLASS }))).toEqual(["catalog:wh"]);
  });

  it("the vendor axis is typed to REAL vendors — a typo cannot compile", () => {
    // Reverting `vendor?: EpisodeSourceVendor` to `vendor?: string` leaves every
    // runtime assertion in this file green and cannot fail typecheck (a wider
    // type is strictly more permissive), so `@ts-expect-error` is the only
    // instrument that pins it. This also restores coverage the narrowing
    // DELETED: `{ vendor: "teams" }` used to be a live runtime case here and
    // stopped compiling, so without this the trade was a net loss.
    // @ts-expect-error "teams" is not a vendor any member names
    void findBrainSourceConnectors({ vendor: "teams" });
    // @ts-expect-error a typo must not read as "that connector is not installed"
    void findBrainSourceConnectors({ vendor: "slakc" });
    // @ts-expect-error the vendorless set is asked for on the CLASS axis
    void findBrainSourceConnectors({ vendor: null });
    // …and the runtime behaviour for an unmatched-but-legal query still holds.
    seedRegistry();
    expect(findBrainSourceConnectors({ vendor: "teams" as EpisodeSourceVendor })).toEqual([]);
  });

  it("AND-s the two axes — a mismatched pair resolves to nothing", () => {
    // Not an OR and not a fallback: asking for the slack vendor within the
    // warehouse class is asking for something that does not exist, and an
    // empty result is the only honest answer. A lookup that fell back to
    // either axis alone would route warehouse work to the Slack connector.
    seedRegistry();
    expect(findBrainSourceConnectors({ sourceClass: WAREHOUSE_CLASS, vendor: "slack" })).toEqual([]);
    expect(findBrainSourceConnectors({ sourceClass: "human", vendor: "slack" })).toEqual([]);
  });

  it("reads both axes off the connector's declared source, not off separate fields", () => {
    // The structural claim behind the contract: a connector declares ONE
    // identity (`source`) and the axes are derived from it, so they cannot
    // disagree with the value that lands in `brain_episodes.source`. Registering
    // a warehouse connector and finding it under the chat class would mean the
    // stored column and this lookup answered different questions.
    registerBrainSourceConnector({
      catalogId: "catalog:only",
      source: WAREHOUSE_SOURCE,
      createClient: () => ({ fetchEpisodes: async () => ({ episodes: [], highWaterMark: null }) }),
    });
    expect(findBrainSourceConnectors({ sourceClass: CHAT_CLASS })).toEqual([]);
    expect(ids(findBrainSourceConnectors({ sourceClass: WAREHOUSE_CLASS }))).toEqual([
      "catalog:only",
    ]);
  });
});
