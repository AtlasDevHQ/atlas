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

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { INSERT_EPISODES_SQL } from "@atlas/api/lib/brain/ingest/episodes";
import {
  _resetBrainSourceConnectors,
  getBrainSourceConnector,
  listBrainSourceCatalogIds,
  registerBrainSourceConnector,
  type BrainSourceConnector,
} from "@atlas/api/lib/brain/ingest/types";

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
  function connector(overrides: Partial<BrainSourceConnector> = {}): BrainSourceConnector {
    return {
      catalogId: "catalog:fixture",
      source: "fixture",
      createClient: () => ({ fetchEpisodes: async () => ({ episodes: [], highWaterMark: null }) }),
      ...overrides,
    };
  }

  it("registers, resolves, and lists a source", () => {
    _resetBrainSourceConnectors();
    registerBrainSourceConnector(connector());
    expect(getBrainSourceConnector("catalog:fixture")?.source).toBe("fixture");
    expect(listBrainSourceCatalogIds()).toEqual(["catalog:fixture"]);
    _resetBrainSourceConnectors();
  });

  it("refuses a duplicate catalog id rather than shadowing an install", () => {
    _resetBrainSourceConnectors();
    registerBrainSourceConnector(connector());
    expect(() => registerBrainSourceConnector(connector())).toThrow(/already registered/);
    _resetBrainSourceConnectors();
  });

  it("refuses a malformed source slug — it is stored verbatim in the table", () => {
    _resetBrainSourceConnectors();
    expect(() => registerBrainSourceConnector(connector({ source: "Slack History" }))).toThrow(
      /invalid/,
    );
    expect(() => registerBrainSourceConnector(connector({ source: "" }))).toThrow(/invalid/);
    _resetBrainSourceConnectors();
  });
});
