/**
 * `atlas-operator seed demo-atlas` — seed the synthetic NovaMart corpus into
 * the DEMO workspace (#5603, launch cycle).
 *
 * Three phases, run singly or together. Extraction sits between `ingest` and
 * `approve` and is NOT a phase: the real fiber drains the episodes on its own
 * cadence, or `--extract` runs one cycle here for a one-shot setup. `approve`
 * on a workspace whose drafts have not been extracted yet promotes nothing and
 * says so.
 *
 *   atlas-operator seed demo-atlas --phase ingest --approved-by <user id>
 *   atlas-operator seed demo-atlas --phase coverage
 *   atlas-operator seed demo-atlas --phase approve --approved-by <user id>
 *   atlas-operator seed demo-atlas --extract --approved-by <user id>   # all three, one cycle between
 *
 * The workspace is always the one whose slug is the demo's; there is no flag
 * to point it elsewhere, because the seed would refuse anyway and a flag that
 * can only ever hold one value is a place for a typo.
 *
 * Targets the tenant Postgres at ATLAS_TEAM_PG_URL (falling back to
 * DATABASE_URL), like the other `seed` subcommands; binds the API's internal
 * pool to it the way `ops heldout-manifest` does, because every write below
 * goes through `@atlas/api/lib/brain/*` seams rather than raw SQL.
 */

import type { ApproveCardinalityOutcome } from "@atlas/api/lib/brain/demo-corpus/seed";
import { getFlag } from "../../../lib/cli-utils";
import { resolveTenantUrl } from "../../../lib/tenant-db";

const TAG = "[seed demo-atlas]";

type Phase = "ingest" | "coverage" | "approve" | "all";

function parsePhase(raw: string | undefined): Phase {
  if (raw === undefined || raw === "all") return "all";
  if (raw === "ingest" || raw === "coverage" || raw === "approve") return raw;
  console.error(`${TAG} Error: --phase must be ingest|coverage|approve|all, got ${JSON.stringify(raw)}`);
  process.exit(1);
}

/**
 * `--approved-by` is the human on the audit row and on the cardinality
 * declaration. Required for every phase that names a person; no default,
 * because "who approved this" is the one question the demo must never answer
 * with a placeholder.
 */
function requireApprover(args: string[], phase: Phase): string | null {
  const approvedBy = getFlag(args, "--approved-by");
  const needed = phase !== "coverage";
  if (needed && !approvedBy) {
    console.error(
      `${TAG} Error: --approved-by <user id> is required for the ${phase} phase — the audit row and the cardinality declaration name the human who ran the seed, and there is no default.`,
    );
    process.exit(1);
  }
  return approvedBy ?? null;
}

/** One line per outcome of the approve phase's keyed `single` declaration (#5620). */
function describeCardinality(outcome: ApproveCardinalityOutcome): string {
  if (outcome.kind === "not-found") {
    return `NOT declared — published rows per rival: ${outcome.found.join("/")}; every rival needs one to declare on`;
  }
  if (outcome.ok) return `declared ${outcome.cardinality} on slot ${JSON.stringify(outcome.slot)}`;
  if (outcome.refusal === "slot-mismatch") {
    return `NOT declared — the rivals occupy ${outcome.slots.length} slots (${outcome.slots.map((s) => JSON.stringify(s)).join(", ")}); alias them together, then re-run --phase approve`;
  }
  return `REFUSED (${outcome.refusal}): ${outcome.message}`;
}

export async function handleSeedDemoAtlas(args: string[]): Promise<void> {
  const phase = parsePhase(getFlag(args, "--phase"));
  const extract = args.includes("--extract");
  const approvedBy = requireApprover(args, phase);

  // Bind the API's internal pool to the tenant DB BEFORE the lib is imported:
  // `getInternalDB()` reads DATABASE_URL lazily on first use, so the order is
  // load-bearing rather than cosmetic.
  process.env.DATABASE_URL = resolveTenantUrl();
  const { closeInternalDB } = await import("@atlas/api/lib/db/internal");
  const seed = await import("@atlas/api/lib/brain/demo-corpus/seed");
  const workspaceRef = seed.DEMO_ATLAS_WORKSPACE_SLUG;

  try {
    if ((phase === "ingest" || phase === "all") && approvedBy !== null) {
      const r = await seed.seedDemoCorpusIngest({ workspaceRef, authoredBy: approvedBy });
      for (const [source, n] of Object.entries(r.episodes)) {
        console.log(`${TAG} ingest ${source}: inserted=${n.inserted} duplicate=${n.duplicate} refused=${n.refused}`);
      }
      const card = r.cardinality.ok
        ? `declared ${r.cardinality.cardinality}`
        : `REFUSED (${r.cardinality.refusal}): ${r.cardinality.message}`;
      console.log(`${TAG} identities captured=${r.identitiesCaptured} cardinality=${card}`);
    }

    if (phase === "coverage" || phase === "all") {
      const r = await seed.seedDemoCorpusCoverage({ workspaceRef });
      console.log(`${TAG} coverage units=${r.units} unsurveyed=${r.unsurveyed.join(",") || "(none)"} persist=${r.persist}`);
    }

    if (extract) {
      const { Effect } = await import("effect");
      const { runBrainExtractionCycle } = await import("@atlas/api/lib/brain/extract");
      const result = await Effect.runPromise(runBrainExtractionCycle());
      console.log(`${TAG} extraction cycle: ${JSON.stringify(result)}`);
    }

    if ((phase === "approve" || phase === "all") && approvedBy !== null) {
      const r = await seed.seedDemoCorpusApprove({ workspaceRef, approvedBy });
      console.log(`${TAG} approve promoted=${r.promoted.length} refused=${r.refused.length} tensionEdges=${r.tensionEdges}`);
      for (const ref of r.refused) console.log(`${TAG}   refused ${ref.id}: ${ref.reasons.join(", ")}`);
      for (const e of r.expected) console.log(`${TAG}   ${e.found ? "✓" : "✗"} ${e.key}`);
      console.log(`${TAG} cardinality (keyed to the published rivals): ${describeCardinality(r.cardinality)}`);
      if (r.promoted.length > 0 && r.tensionEdges === 0) {
        console.log(
          `${TAG} no in-tension-with edge on the workspace: the extractor did not hint the return-window predicate single, so reconcile minted nothing at write time. The predicate is declared single (the literal surface at ingest, the rivals' own key at approve), so an admin's tension sweep (the facts page, or POST /api/v1/admin/brain-facts/tension-sweep) will mint the contradiction's edge — deliberately not run from here (ADR-0037 §7: one caller).`,
        );
      }
      if (r.missing.length > 0) {
        console.log(
          `${TAG} ${r.missing.length} expected claim(s) not found among published corpus claims — extraction may not have run yet (re-run with --phase approve after the fiber drains, or with --extract), or the corpus needs rewording. Nothing was inserted in their place.`,
        );
        process.exitCode = 2;
      }
    }
  } catch (err) {
    console.error(`${TAG} failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await closeInternalDB().catch((closeErr: unknown) => {
      console.warn(`${TAG} pool close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
    });
  }
}
