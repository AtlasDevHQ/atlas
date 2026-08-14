/**
 * Region-migration bundle-scope drift tripwire (#4460).
 *
 * The bug this pins: pillars shipped after the export bundle was defined
 * (dashboards, knowledge, scheduled tasks, integrations, durable sessions)
 * silently stayed in the source region because nothing forced a per-table
 * decision. This suite enumerates every table in the Drizzle schema and fails
 * when one appears with no explicit entry in `BUNDLE_TABLE_DECISIONS` — so
 * the NEXT new pillar breaks CI instead of silently missing the bundle.
 *
 * It also pins the registry to the implementation: every `exported` table
 * must actually be read by `export.ts` and written by `admin-migrate.ts`.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@atlas/api/lib/db/schema";
import {
  BUNDLE_TABLE_DECISIONS,
  EXPORTED_TABLES,
  STAYS_TABLES,
  type BundleTableScope,
} from "../bundle-scope";

// String-indexed view: the registry's literal-keyed type (via `satisfies`)
// rejects arbitrary-string indexing, which is exactly what this suite does.
const decisionFor: Readonly<Record<string, BundleTableScope | undefined>> = BUNDLE_TABLE_DECISIONS;

// ── Enumerate the live schema ────────────────────────────────────────

const schemaTables = Object.values(schema).flatMap((v) =>
  is(v, PgTable) ? [getTableConfig(v)] : [],
);

const schemaTableNames = schemaTables.map((t) => t.name);

describe("bundle-scope drift tripwire (#4460)", () => {
  it("enumerates a plausible schema (sanity: the known pillars are present)", () => {
    // Guards the enumeration itself — if the Drizzle introspection ever came
    // back empty, every other assertion would vacuously pass.
    expect(schemaTableNames.length).toBeGreaterThan(50);
    for (const known of ["conversations", "dashboards", "knowledge_documents", "scheduled_tasks", "agent_runs"]) {
      expect(schemaTableNames).toContain(known);
    }
  });

  it("every schema table has an explicit export decision (new pillar ⇒ decide before merge)", () => {
    const undecided = schemaTableNames.filter((name) => !(name in BUNDLE_TABLE_DECISIONS));
    expect(
      undecided,
      `New table(s) with no region-migration export decision: ${undecided.join(", ")}.\n` +
        `Add each to BUNDLE_TABLE_DECISIONS in lib/residency/bundle-scope.ts — decide whether it ` +
        `moves in the export bundle ('exported'), stays behind and is deleted by the #4458 cleanup ` +
        `('stays'), or is platform/auth-spine state outside the workspace scope ('platform'). ` +
        `If 'exported', wire it through export.ts + admin-migrate.ts and update the "What moves" ` +
        `table in data-residency.mdx.`,
    ).toEqual([]);
  });

  it("has no stale registry entries for dropped tables", () => {
    const stale = Object.keys(BUNDLE_TABLE_DECISIONS).filter(
      (name) => !schemaTableNames.includes(name),
    );
    expect(
      stale,
      `Registry entries for tables no longer in db/schema.ts: ${stale.join(", ")}. ` +
        `Remove them from BUNDLE_TABLE_DECISIONS.`,
    ).toEqual([]);
  });

  it("every decision carries a non-empty rationale", () => {
    for (const [name, entry] of Object.entries(BUNDLE_TABLE_DECISIONS)) {
      expect(entry.reason.trim().length, `${name} has an empty reason`).toBeGreaterThan(0);
    }
  });

  it("pins the decided v2 bundle scope exactly", () => {
    // The maintainer-approved scope from #4460. Changing this list is a
    // product decision — update the issue trail + data-residency.mdx with it.
    //
    // Extended by #4767 (ADR-0036) with the four company-brain tables. The
    // decision: a workspace's brain is the same class of asset as its
    // knowledge base, so it moves. The alternative classification ('stays')
    // is not neutral — stays rows are DELETED from the source after the
    // grace period, which would make a region migration silently destroy the
    // workspace's accumulated knowledge.
    //
    // Extended again by #5022 (ADR-0037 §6/§8) with the vocabulary's DURABLE
    // half, on the same reasoning one layer down: the aliases are curated by a
    // human and the keys they produced travel verbatim, so 'stays' would destroy
    // the decisions at source AND leave the imported keys un-re-derivable.
    // `brain_vocabulary_target` is deliberately NOT here — it is the derived
    // closure, and §8 has the import recompute it rather than carry it.
    //
    // Extended again by #5203 with the brain's Slack ingest scope, on the same
    // reasoning pointed the other way. The tables carry a NARROWING — which
    // channels a human took OUT of scope — and since scope is now "every channel
    // the bot is in, minus exclusions", losing that narrowing does not degrade
    // the destination, it makes the destination ingest a channel a human
    // removed. Over-DISCLOSURE, the unrecoverable direction, and 'stays' is
    // deletion (#4458) so the source's copy would be destroyed in the same move.
    // Only the exclusion HALF of `brain_slack_channel` rides; the observed
    // membership beside it is re-derived on the target's first sync.
    expect([...EXPORTED_TABLES].toSorted()).toEqual([
      "agent_session_memory",
      "brain_edges",
      "brain_episodes",
      "brain_facts",
      "brain_slack_channel",
      "brain_slack_ingest_scope",
      "brain_vocabulary_edge",
      "conversations",
      "dashboard_cards",
      "dashboard_user_drafts",
      "dashboards",
      "fact_audience_member",
      "knowledge_documents",
      "knowledge_links",
      "learned_patterns",
      "messages",
      "scheduled_tasks",
      "semantic_entities",
      "settings",
    ]);
  });

  it("every exported table is actually read by the export implementation", () => {
    const exportSource = readFileSync(join(import.meta.dir, "..", "export.ts"), "utf8");
    for (const table of EXPORTED_TABLES) {
      expect(
        exportSource.includes(`FROM ${table}`),
        `bundle-scope.ts says '${table}' is exported, but export.ts has no 'FROM ${table}' query — ` +
          `the registry and the implementation have drifted.`,
      ).toBe(true);
    }
  });

  it("no non-exported table is read by the export implementation (reverse drift)", () => {
    // The inverse tripwire: a table wired into export.ts while classified
    // 'stays'/'platform' would ship data the registry — and #4458's deletion
    // scoping — says stays behind. Both directions must agree.
    const exportSource = readFileSync(join(import.meta.dir, "..", "export.ts"), "utf8");
    const nonExported = schemaTableNames.filter((name) => !EXPORTED_TABLES.includes(name));
    for (const table of nonExported) {
      expect(
        exportSource.includes(`FROM ${table}`) || exportSource.includes(`JOIN ${table}`),
        `export.ts queries '${table}', but bundle-scope.ts classifies it as non-exported — ` +
          `either reclassify it 'exported' or remove the query.`,
      ).toBe(false);
    }
  });

  /**
   * Where each exported table's RESTORING statement lives.
   *
   * `admin-migrate.ts` for everything by default — it is the import path, and
   * for an ordinary section the INSERT is spelled there inline.
   *
   * ⚠️ `brain_vocabulary_edge` is the one delegation, and it is a delegation
   * rather than a loophole (#5036). Restoring an alias edge is a MERGE, not an
   * insert: the arriving edge has to be screened against this region's own
   * approved edges for at-most-one-parent and for cycles, which are the exact
   * four rules `approveAliasEdge` applies. Spelled a second time in the route
   * they would drift, and `lib/` must not import from `api/routes/` — so the
   * shared implementation lives in `lib/brain/vocabulary.ts` and the route calls
   * `mergeApprovedEdges`.
   *
   * ⚠️ A DELEGATED WRITER NAMES ITS FUNCTION, and the scoping is load-bearing
   * rather than tidiness. `vocabulary.ts` contains TWO
   * `INSERT INTO brain_vocabulary_edge` statements — `approveAliasEdge`'s and
   * `mergeApprovedEdges`' — so a whole-file search stays true after the IMPORT
   * path's write is deleted outright, which is precisely the drift this arm
   * exists to catch. The single-file form never had that problem, because
   * `admin-migrate.ts` held exactly one. Searching only the delegated function's
   * own body restores the original strength.
   */
  const IMPORT_WRITER: Readonly<
    Partial<Record<string, { readonly path: readonly string[]; readonly symbol: string }>>
  > = {
    brain_vocabulary_edge: {
      path: ["..", "..", "brain", "vocabulary.ts"],
      symbol: "export async function mergeApprovedEdges",
    },
  };
  const DEFAULT_IMPORT_WRITER = ["..", "..", "..", "api", "routes", "admin-migrate.ts"] as const;

  /**
   * The source of the declaration `symbol` opens, up to the next top-level
   * declaration, with COMMENTS STRIPPED.
   *
   * ⚠️ Both halves are load-bearing and the first cut of this helper had neither.
   *
   * Comments, because the terminator matches a DECLARATION line and every
   * declaration in this repo is preceded by a docblock — so the slice ran to the
   * end of the NEXT function's documentation, roughly 10 KB whose tail was the
   * whole of `removeAliasEdge`'s docblock. Nothing in that tail quotes the
   * statement TODAY; the hazard is that in a codebase whose docblocks routinely
   * quote SQL, a tripwire a COMMENT can satisfy is not a tripwire. Delete the
   * real INSERT, mention it in the next function's prose, and the suite goes
   * green. The falsifier below pins that directly rather than resting on a
   * measurement that drifts with every comment edit in `vocabulary.ts`.
   *
   * The wider terminator, because `export enum` / `export default` /
   * `export abstract class` / `export function*` were all unmatched — and an
   * unmatched terminator runs the slice to EOF, so everything BELOW
   * `mergeApprovedEdges` counts as its body. No statement down there satisfies
   * the tripwire today, which is exactly why that failure would be silent: the
   * first `INSERT INTO brain_vocabulary_edge` added below this function would
   * stand in for the merge's own. (`approveAliasEdge`'s INSERT sits ABOVE the
   * start point and is structurally out of reach either way — the slice only
   * extends forward.)
   */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const declarationBody = (source: string, symbol: string): string => {
    const src = stripComments(source);
    const start = src.indexOf(symbol);
    expect(start, `delegated writer '${symbol}' no longer exists`).toBeGreaterThanOrEqual(0);
    const rest = src.slice(start + symbol.length);
    const end = rest.search(
      /\nexport (?:default |declare |abstract )?(?:async function|function\*?|const|interface|type|class|enum) /,
    );
    return end === -1 ? rest : rest.slice(0, end);
  };

  it("declarationBody isolates the delegated writer — the tripwire's own falsifier", () => {
    // ⚠️ `declarationBody` is machinery INSIDE a guard, so it needs its own
    // guard: a slicer that quietly returned the whole file would make the arm
    // below pass for every possible edit, which is worse than no arm at all.
    // The `removeAliasEdge` bound and the comment-stripping case were both RED
    // against this helper's first cut.
    const vocabularySource = readFileSync(
      join(import.meta.dir, "..", "..", "brain", "vocabulary.ts"),
      "utf8",
    );
    const mergeBody = declarationBody(vocabularySource, "export async function mergeApprovedEdges");

    // It stops before the neighbour BELOW it. `removeAliasEdge` is the one whose
    // docblock the un-stripped slice swept up, so that bound is the assertion
    // that was actually red.
    expect(mergeBody).not.toContain("export async function removeAliasEdge");
    // `approveAliasEdge` holds the OTHER `INSERT INTO brain_vocabulary_edge` and
    // sits ABOVE the start point, so it can never appear in a forward-only
    // slice. Kept as a readability marker naming the statement this arm exists
    // to exclude — NOT a falsifier: it is vacuously true for any implementation.
    expect(mergeBody).not.toContain("export async function approveAliasEdge");

    // And a COMMENT cannot satisfy it. `removeAliasEdge`'s docblock follows the
    // merge in the file, so an un-stripped slice swept it up — and any docblock
    // quoting the statement would then stand in for the code.
    const withPretendComment = declarationBody(
      `export async function mergeApprovedEdges() { return 1; }\n` +
        `/** INSERT INTO brain_vocabulary_edge — prose, not code */\n` +
        `export async function next() {}\n`,
      "export async function mergeApprovedEdges",
    );
    expect(withPretendComment).not.toContain("INSERT INTO brain_vocabulary_edge");
  });

  it("every exported table is actually written by the import implementation", () => {
    for (const table of EXPORTED_TABLES) {
      const delegated = IMPORT_WRITER[table];
      const relative = delegated?.path ?? DEFAULT_IMPORT_WRITER;
      const source = readFileSync(join(import.meta.dir, ...relative), "utf8");
      const writer = relative[relative.length - 1];
      const haystack = delegated ? declarationBody(source, delegated.symbol) : source;
      const where = delegated ? `${writer}'s ${delegated.symbol.split(" ").pop()}` : writer;
      expect(
        haystack.includes(`INSERT INTO ${table}`),
        `bundle-scope.ts says '${table}' is exported, but ${where} has no ` +
          `'INSERT INTO ${table}' — the bundle would be produced but never restored.`,
      ).toBe(true);
    }
  });

  it("the import path still REACHES every delegated writer", () => {
    // The half the lookup above cannot check on its own. Pointing the tripwire
    // at another file proves a statement exists there; it does not prove the
    // route still calls it. Without this, deleting the `mergeApprovedEdges` call
    // from `admin-migrate.ts` would leave the vocabulary silently unrestored
    // with every drift test green — which is precisely the failure the original
    // single-file assertion was strong against, handed back the moment the
    // indirection was allowed.
    const routeSource = readFileSync(join(import.meta.dir, ...DEFAULT_IMPORT_WRITER), "utf8");
    expect(Object.keys(IMPORT_WRITER)).toEqual(["brain_vocabulary_edge"]);
    expect(routeSource).toContain("mergeApprovedEdges(");
  });

  it("org-scoped tables classified 'platform' stay a pinned, deliberate exemption set", () => {
    // A table carrying org_id/workspace_id is workspace-scoped on its face —
    // classifying one as 'platform' (untouched by the bundle AND by the #4458
    // cleanup) must be a deliberate call, not a default. This pins the current
    // exemptions; a NEW org-scoped table classified 'platform' fails here
    // until it is either reclassified or added with a recorded rationale in
    // bundle-scope.ts.
    const orgScopedPlatform = schemaTables
      .filter((t) => {
        const entry = decisionFor[t.name];
        if (!entry || entry.decision !== "platform") return false;
        return t.columns.some((c) => c.name === "org_id" || c.name === "workspace_id");
      })
      .map((t) => t.name)
      .toSorted();

    expect(orgScopedPlatform).toEqual([
      "abuse_events", // platform abuse telemetry keyed by workspace for attribution only
      "crm_outbox", // operator lead pipeline; workspace column is provenance
      "email_outbox", // transient delivery queue
      "oauth_state", // transient handshake state, short TTL
      "onboarding_emails", // operator drip bookkeeping
      "region_migrations", // the migration bookkeeping itself
      "stripe_teardown_pending", // global billing-teardown queue
      "user_trial_grants", // global billing/abuse spine (user-keyed)
    ]);
  });

  it("the three buckets partition the schema (no table in two states)", () => {
    // Record<string, …> gives us this by construction today; the assertion
    // documents the invariant the #4458 cleanup relies on: delete exactly
    // the org rows of STAYS_TABLES ∪ (exported tables, already moved) and
    // never touch 'platform'.
    const total = EXPORTED_TABLES.length + STAYS_TABLES.length +
      Object.values(BUNDLE_TABLE_DECISIONS).filter((d) => d.decision === "platform").length;
    expect(total).toBe(Object.keys(BUNDLE_TABLE_DECISIONS).length);
    expect(total).toBe(schemaTableNames.length);
  });
});
