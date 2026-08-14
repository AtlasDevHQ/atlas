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
  listPerWorkspaceBrainSources,
  registerBrainSourceConnector,
  type BrainSourceAudienceFor,
  type BrainSourceConnector,
} from "@atlas/api/lib/brain/ingest/types";
import {
  _resetCatalogIngestClaims,
  claimCatalogIngestTarget,
  getCatalogIngestTarget,
} from "@atlas/api/lib/knowledge/catalog-claims";
import {
  ZERO_REVERIFY,
  listAudienceReverifierSources,
  registerAudienceReverifier,
  runRegisteredAudienceReverifiers,
} from "@atlas/api/lib/brain/audience/reverify";
import {
  CHAT_CLASS,
  HUMAN_SOURCE,
  OUTLOOK_SOURCE,
  SLACK_SOURCE,
  episodeSourceClass,
  WAREHOUSE_CLASS,
  WAREHOUSE_SOURCE,
  ZOOM_SOURCE,
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
  //
  // The knowledge-documents release is NOT covered by the first call —
  // `_resetBrainSourceConnectors` releases only the `brain-episodes` claims, by
  // design. One test below claims `catalog:fixture` for the OTHER target to
  // provoke a collision, and as a trailing statement that release would be
  // skipped by a throwing assertion, leaving every later registration of
  // `catalog:fixture` — the rest of THIS describe; the sibling one uses other
  // ids — failing with `already registered as knowledge-documents`, one real
  // failure manufacturing several unrelated ones. Harmless when nothing claimed.
  afterEach(() => {
    _resetBrainSourceConnectors();
    _resetCatalogIngestClaims("knowledge-documents");
  });

  // The fixture's SOURCE KIND is a real vocabulary member
  // (`lib/brain/sources.ts`) while its CATALOG ID stays fixture-shaped — the
  // two are independent, which is the point: one kind can back many catalog
  // rows. A made-up kind here would no longer register (see the vocabulary
  // test below).
  function connector(overrides: Partial<BrainSourceConnector> = {}): BrainSourceConnector {
    return {
      catalogId: "catalog:fixture",
      source: SLACK_SOURCE,
      // Chat-class ⇒ per-workspace (#5203); registration refuses per-install
      // for the chat class, which is the whole falsification.
      scope: {
        kind: "per-workspace" as const,
        syncId: "fixture-sync",
        listWorkspaces: () => Promise.resolve([]),
      },
      // Chat grants are reconciled by the install-driven Slack walk, so the
      // default fixture registers no re-verifier. The tests below that DO care
      // override it.
      audience: { kind: "externally-synced" },
      createClient: () => ({ fetchEpisodes: async () => ({ episodes: [], highWaterMark: null }) }),
      ...overrides,
    };
  }

  it("registers, resolves, and lists a source", () => {
    _resetBrainSourceConnectors();
    registerBrainSourceConnector(connector());
    expect(getBrainSourceConnector("catalog:fixture")?.source).toBe(SLACK_SOURCE);
    // ⚠️ The default fixture is CHAT-class, so since #5203 it is per-workspace
    // and deliberately absent from the install-walk filter — a catalog id in
    // there matches no install row, and the cycle would report a clean pass
    // having synced nothing. Asserted on BOTH listings rather than just the
    // per-workspace one: `toEqual([])` alone would also pass against a filter
    // that had stopped returning anything at all.
    expect(listBrainSourceCatalogIds()).toEqual([]);
    expect(listPerWorkspaceBrainSources().map((c) => c.catalogId)).toEqual(["catalog:fixture"]);

    // A per-install source still lands in the install-walk filter.
    registerBrainSourceConnector({ ...connector(), catalogId: "catalog:zoomish", source: ZOOM_SOURCE, scope: { kind: "per-install" }, audience: { kind: "reverified", reverifier: async () => ({ ...ZERO_REVERIFY }) } });
    expect(listBrainSourceCatalogIds()).toEqual(["catalog:zoomish"]);
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
    // would then never match it. Since #4964 that no longer fails OPEN (the
    // correction path is quarantined instead, and `correction.test.ts` loops
    // these very slugs), but the hazard is only converted, not removed: every
    // fact the connector produced becomes uncorrectable workspace-wide until
    // the vocabulary admits the kind. Registration is where that has to stop,
    // because nothing downstream can tell a novel class from a typo.
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

  // ── The audience half, registered as ONE unit with the connector (#4985) ──

  /**
   * A DISTINCTIVE counter, so the re-verifier can be identified by its OUTPUT and
   * not merely by the key it landed under. `ZERO_REVERIFY` would make the
   * declared re-verifier indistinguishable from any other — see the drain in
   * "commits the connector AND the DECLARED re-verifier from one call".
   */
  const REVERIFIER_FINGERPRINT = Object.freeze({ ...ZERO_REVERIFY, membersAdded: 7 });

  /**
   * A `reverified` fixture on WAREHOUSE_SOURCE, not on the fixture default.
   *
   * The key the re-verifier lands under has to be DERIVED from
   * `connector.source`, and the assertions below are the only thing pinning that.
   * On `SLACK_SOURCE` — which is both the fixture default and the value a
   * hardcoding mutation would most plausibly reach for — a
   * `prepareAudienceReverifier(SLACK_SOURCE, …)` mutation would pass every one of
   * them. Same argument `episode-sync.test.ts` records for using `HUMAN_SOURCE`
   * in its fixture. `warehouse` is not a grant-deriving class, so it may declare
   * either arm and the runtime backstop is not what is under test here.
   */
  const reverified = (): BrainSourceConnector =>
    connector({
      source: WAREHOUSE_SOURCE,
      audience: { kind: "reverified", reverifier: () => Promise.resolve(REVERIFIER_FINGERPRINT) },
    });

  it("commits the connector AND the DECLARED re-verifier from one call", async () => {
    // The `reverified` arm is not decoration: a source that declares it must end
    // up in BOTH registries off a single `registerBrainSourceConnector`, because
    // the whole point of folding the audience strategy into the connector value
    // is that there is no second statement anyone can forget.
    //
    // MUTATION THIS CATCHES: dropping the `commitReverifier()` call; keying it on
    // a literal instead of `connector.source`; and — only because of the VALUE
    // assertion below — committing some other function under the right key.
    // Asserting the key alone let that last one survive, and it is the worst of
    // the three: a source registered, keyed correctly, and re-verified by
    // something that does nothing is the exact 168h decay this seam prevents.
    //
    // The precondition is load-bearing, not ceremony: without it a re-verifier
    // leaked by an earlier test makes this pass for the wrong reason.
    expect(listAudienceReverifierSources()).toEqual([]);

    registerBrainSourceConnector(reverified());

    expect(getBrainSourceConnector("catalog:fixture")).toBeDefined();
    expect(listAudienceReverifierSources()).toEqual([WAREHOUSE_SOURCE]);
    // Drain the registry and read the fingerprint back: this is what proves the
    // committed function is the one the connector declared.
    expect(await runRegisteredAudienceReverifiers()).toEqual(REVERIFIER_FINGERPRINT);
  });

  it("registers NO re-verifier for an externally-synced source", () => {
    // The other arm has to be a real branch, not a shrug. Slack's grants are
    // reconciled by the install-driven walk, and a connector that quietly
    // registered a re-verifier anyway would put a second writer on audiences the
    // walk already owns.
    //
    // No mutation is named because none is expressible: the branch reads
    // `audience.kind`, and the other arm has no `.reverifier` to pass. It earns
    // its place as the leak detector for the test above.
    registerBrainSourceConnector(connector());
    expect(getBrainSourceConnector("catalog:fixture")).toBeDefined();
    expect(listAudienceReverifierSources()).toEqual([]);
  });

  it("⭐ registers NEITHER half when the re-verifier registry is already taken", () => {
    // The half-state this seam exists to prevent, asserted at the registry rather
    // than per-vendor. A connector committed with its re-verifier rejected ingests
    // normally for ATLAS_BRAIN_AUDIENCE_MAX_STALENESS_HOURS (168h) and only then
    // goes wrong, at which point `acl.ts` suppresses every audience nothing
    // refreshed and the facts behind them read as ABSENT rather than denied.
    //
    // MUTATION THIS CATCHES: moving `claimCatalogIngestTarget` / `registry.set`
    // above the `prepareAudienceReverifier` call, i.e. writing before validating.
    // All THREE structures are asserted, so no half of the mutation slips past —
    // the claim in particular has no other assertion anywhere in this file.
    registerAudienceReverifier(WAREHOUSE_SOURCE, () => Promise.resolve(ZERO_REVERIFY));

    // Which REGISTRY refused, not the shared prefix: the duplicate CATALOG ID
    // error also ends in "is already registered", so `/already registered/` alone
    // cannot discriminate — and this test is meaningless unless it was the
    // re-verifier one.
    expect(() => registerBrainSourceConnector(reverified())).toThrow(
      /re-verifier for source .* is already registered/,
    );

    expect(getBrainSourceConnector("catalog:fixture")).toBeUndefined();
    expect(getCatalogIngestTarget("catalog:fixture")).toBeUndefined();
    expect(listBrainSourceCatalogIds()).toEqual([]);
  });

  it("⭐ leaves the re-verifier registry EMPTY when the catalog claim collides", () => {
    // The other throw site above the writes, and the one with no coverage before
    // #4985: `claimCatalogIngestTarget` sits BETWEEN the prepare and the commit.
    // If `prepareAudienceReverifier` wrote eagerly and returned a no-op — a
    // tempting "simplification" — this collision would leave a re-verifier for a
    // source with no connector. That inverted half-state is loud rather than
    // silent — any later registration attempt sees no connector, walks past the
    // idempotence gate, and throws `already registered` — but it is still a
    // partial commit.
    //
    // MUTATION THIS CATCHES: making `prepareAudienceReverifier` commit eagerly, or
    // hoisting `commitReverifier()` above `claimCatalogIngestTarget`.
    claimCatalogIngestTarget("catalog:fixture", "knowledge-documents");

    expect(() => registerBrainSourceConnector(reverified())).toThrow(
      /already registered as knowledge-documents/,
    );

    expect(listAudienceReverifierSources()).toEqual([]);
    expect(getBrainSourceConnector("catalog:fixture")).toBeUndefined();
    // The knowledge-documents claim is released in `afterEach`, not here — see
    // its comment for why a trailing release would cascade.
  });

  it("⭐ refuses a grant-deriving class that declares externally-synced", () => {
    // The RUNTIME backstop for the lane the type cannot see. `BrainSourceAudienceFor`
    // makes this a TS2322 at a literal-typed connector, but a plugin arrives as
    // data, and a cast or a widened return type compiles. No cast is needed to
    // express it HERE — `connector()` takes `Partial<BrainSourceConnector>` at the
    // default `S`, where the conditional is false and both arms are legal, so the
    // fixture's own parameter type is the widener. That is the same widening a
    // factory reintroduces by declaring the unparameterised return type.
    //
    // MUTATION THIS CATCHES: deleting the `requiresAudienceReverifier` branch from
    // `registerBrainSourceConnector`.
    const widened = connector({
      source: ZOOM_SOURCE,
      audience: { kind: "externally-synced" },
    });

    expect(() => registerBrainSourceConnector(widened)).toThrow(/MUST declare audience/);
    // …and the actionable half — what a plugin author actually reads.
    expect(() => registerBrainSourceConnector(widened)).toThrow(/reads as ABSENT rather than denied/);

    expect(listBrainSourceCatalogIds()).toEqual([]);
    expect(listAudienceReverifierSources()).toEqual([]);

    // The same class WITH a re-verifier still registers, so this is a pairing rule
    // and not a blanket refusal of the transcript class.
    expect(() =>
      registerBrainSourceConnector(
        connector({
          source: ZOOM_SOURCE,
          audience: { kind: "reverified", reverifier: () => Promise.resolve(ZERO_REVERIFY) },
        }),
      ),
    ).not.toThrow();
  });

  it("refuses a malformed audience declaration rather than throwing a TypeError", () => {
    // Same data lane. An absent field used to surface as `undefined is not an
    // object (evaluating 'connector.audience.kind')` — fail-closed, but the one
    // input whose absence is the entire subject of #4985 deserves the same
    // actionable message every other invalid input here gets.
    //
    // A `reverified` arm with no function is the subtler half: it would register
    // `undefined` and make `runRegisteredAudienceReverifiers` count that source
    // failed on every cycle, forever. The last case is the CONTRADICTION —
    // declaring that something else owns the refresh while supplying a
    // re-verifier — which excess-property checking blocks in-repo but a plugin's
    // data can express; dropping the function silently would age its audiences out.
    for (const bad of [
      undefined,
      null,
      {},
      { kind: "nonsense" },
      { kind: "reverified" },
      { kind: "externally-synced", reverifier: () => Promise.resolve(ZERO_REVERIFY) },
    ]) {
      expect(() =>
        registerBrainSourceConnector(connector({ audience: bad } as Partial<BrainSourceConnector>)),
      ).toThrow(/declared no usable audience strategy/);
    }
    expect(listBrainSourceCatalogIds()).toEqual([]);
  });

  it("⭐ a grant-deriving class cannot declare externally-synced (COMPILE time)", () => {
    // AC-5 of #4985, pinned. Everything else in this describe is a runtime
    // assertion, and the compile-time narrowing degrades SILENTLY and in the
    // permissive direction.
    //
    // MUTATIONS THIS CATCHES, all three verified by applying them:
    //   - annotating `EPISODE_SOURCE_SPECS` `Record<EpisodeSource, EpisodeSourceSpec>`,
    //     which widens `class` off the literal;
    //   - reverting `BrainSourceAudienceFor` to a bare `BrainSourceAudience`;
    //   - flipping `AUDIENCE_GRAIN.transcript` to `not-required`.
    //
    // ⚠️ Two nearby edits are NOT caught, and naming them is the point: dropping
    // an `as const` from an `EPISODE_SOURCE_SPECS` entry does not weaken anything
    // (its `satisfies EpisodeSourceSpec` supplies the literal contextually), and
    // neither does dropping the `const` modifier on `registerBrainSourceConnector`'s
    // type parameter (the constraint is already a literal union). Both were
    // checked; neither degrades the type, so there is nothing here to catch.
    //
    // `@ts-expect-error` is the instrument — the same one `sources.test.ts` uses
    // for the sibling claim — because it inverts: when the narrowing evaporates
    // the annotation stops erroring and the unused directive becomes the failure.
    //
    // ⚠️ So this test has NO teeth under `bun test` — bun strips types and the
    // `toHaveLength(3)` below is trivially true. The gate is `bun run type`
    // (tsgo, /ci stage 0), which type-checks the whole repo, this file included.
    // Do not "verify" it with the isolated runner and conclude it is dead weight.
    //
    // @ts-expect-error zoom is transcript-class — the reverified arm is the only one
    const zoom: BrainSourceAudienceFor<typeof ZOOM_SOURCE> = { kind: "externally-synced" };
    // @ts-expect-error outlook is email-class — same
    const outlook: BrainSourceAudienceFor<typeof OUTLOOK_SOURCE> = { kind: "externally-synced" };
    // Chat is NOT grant-deriving, so both arms are legal — no directive here, and
    // that asymmetry is what proves the conditional discriminates rather than
    // refusing everything.
    const slack: BrainSourceAudienceFor<typeof SLACK_SOURCE> = { kind: "externally-synced" };

    expect([zoom, outlook, slack]).toHaveLength(3);
  });

  it("⭐ …and the check reaches an INLINE connector literal, not just the alias", () => {
    // The annotations above pin the type; this pins that it still ARRIVES at the
    // shape production writes. `registerBrainSourceConnector` infers `S` from its
    // argument, and retyping that parameter to a bare `BrainSourceConnector` — or
    // widening the `source` field — would leave every assertion above green while
    // the compile-time check silently stopped applying at every real call site.
    //
    // Never invoked: it is compiled, which is the whole point, and calling it
    // would just exercise the runtime backstop the sibling test already covers.
    const unreachable = (): void => {
      registerBrainSourceConnector({
        catalogId: "catalog:never-registered",
        source: ZOOM_SOURCE,
        // @ts-expect-error zoom is transcript-class — the inline literal is checked at the CALL
        audience: { kind: "externally-synced" },
        createClient: () => ({ fetchEpisodes: async () => ({ episodes: [], highWaterMark: null }) }),
      });
    };

    expect(typeof unreachable).toBe("function");
    expect(listBrainSourceCatalogIds()).toEqual([]);
  });

  it("⭐ _resetBrainSourceConnectors tears down the re-verifier registry too", () => {
    // The teardown mirrors the registration. If it stopped doing so, every suite
    // that registers a brain source and re-registers it would fail on a duplicate
    // re-verifier — a failure with nothing to do with what it was testing —
    // because the `register*Connector` idempotence gates read only the CONNECTOR
    // registry and would wave the second attempt through.
    //
    // MUTATION THIS CATCHES: dropping `_resetAudienceReverifiers()` from
    // `_resetBrainSourceConnectors`.
    expect(listAudienceReverifierSources()).toEqual([]);
    registerBrainSourceConnector(reverified());
    expect(listAudienceReverifierSources()).toEqual([WAREHOUSE_SOURCE]);

    _resetBrainSourceConnectors();

    expect(listAudienceReverifierSources()).toEqual([]);
    expect(() => registerBrainSourceConnector(reverified())).not.toThrow();
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
      // Chat-class sources may only be per-workspace (#5203); everything else
      // in this fixture keeps the install-driven shape.
      scope:
        episodeSourceClass(source) === "chat"
          ? { kind: "per-workspace", syncId: `${catalogId}-sync`, listWorkspaces: () => Promise.resolve([]) }
          : { kind: "per-install" },
      audience: { kind: "externally-synced" },
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
      scope: { kind: "per-install" },
      audience: { kind: "externally-synced" },
      createClient: () => ({ fetchEpisodes: async () => ({ episodes: [], highWaterMark: null }) }),
    });
    expect(findBrainSourceConnectors({ sourceClass: CHAT_CLASS })).toEqual([]);
    expect(ids(findBrainSourceConnectors({ sourceClass: WAREHOUSE_CLASS }))).toEqual([
      "catalog:only",
    ]);
  });
});
