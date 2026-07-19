/**
 * atlas-operator export -- Export workspace data to a portable migration bundle (JSON).
 *
 * Operator-only direct-DB tooling, dispatched from bin/atlas-operator.ts (ADR-0025 step 4, #4045).
 *
 * Delegates to `exportWorkspaceBundle` — the SINGLE bundle producer shared
 * with the region-migration executor (#4460) — so the CLI bundle scope can
 * never drift from the server's. The per-table moves/stays decision registry
 * lives in `@atlas/api/lib/residency/bundle-scope.ts`.
 */

import * as fs from "fs";
import pc from "picocolors";
import { getFlag } from "../../../lib/cli-utils";

export async function handleExport(args: string[]): Promise<void> {
  const outputArg = getFlag(args, "--output") ?? getFlag(args, "-o");
  const orgArg = getFlag(args, "--org");

  // Require DATABASE_URL
  if (!process.env.DATABASE_URL) {
    console.error(pc.red("DATABASE_URL is required for atlas-operator export."));
    console.error(
      "  The export reads conversations, settings, and learned patterns from the internal database.",
    );
    console.error(
      "  Set DATABASE_URL=postgresql://... to point to your Atlas internal database.",
    );
    process.exit(1);
  }

  const { closeInternalDB } = await import("@atlas/api/lib/db/internal");

  try {
    console.log("\nAtlas Export -- creating migration bundle...\n");

    // Org filter: a concrete org id, or null for a no-auth self-hosted
    // instance whose rows carry org_id IS NULL.
    const orgFilter = orgArg ?? null;

    const { exportWorkspaceBundle } = await import(
      "@atlas/api/lib/residency/export"
    );
    const bundle = await exportWorkspaceBundle(
      orgFilter,
      orgFilter ? `org:${orgFilter}` : "self-hosted",
      process.env.ATLAS_API_URL ?? "http://localhost:3001",
    );

    const counts = bundle.manifest.counts;
    console.log(`  Conversations:      ${counts.conversations}`);
    console.log(`  Messages:           ${counts.messages}`);
    console.log(`  Entities:           ${counts.semanticEntities}`);
    console.log(`  Patterns:           ${counts.learnedPatterns}`);
    console.log(`  Settings:           ${counts.settings}`);
    console.log(`  Dashboards:         ${counts.dashboards ?? 0} (${counts.dashboardCards ?? 0} cards, ${counts.dashboardUserDrafts ?? 0} drafts)`);
    console.log(`  Knowledge docs:     ${counts.knowledgeDocuments ?? 0} (${counts.knowledgeLinks ?? 0} links)`);
    console.log(`  Scheduled tasks:    ${counts.scheduledTasks ?? 0}`);
    console.log(`  Session memory:     ${counts.agentSessionMemory ?? 0}`);

    // Write output
    const date = new Date().toISOString().slice(0, 10);
    const outPath = outputArg ?? `./atlas-export-${date}.json`;
    fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2));
    console.log(
      `\n${pc.green("✓")} Bundle written to ${pc.bold(outPath)}`,
    );
    console.log(
      `  Total size: ${(Buffer.byteLength(JSON.stringify(bundle)) / 1024).toFixed(1)} KB`,
    );
    console.log(
      `\nNext: ATLAS_API_KEY=sk-... atlas migrate-import --bundle ${outPath} --target https://app.useatlas.dev`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(pc.red(`Export failed: ${detail}`));
    process.exit(1);
  } finally {
    await closeInternalDB();
  }
}
