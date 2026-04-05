/**
 * atlas improve — Analyze the semantic layer and propose improvements.
 *
 * Supports batch mode (--apply) and interactive mode (-i).
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import pc from "picocolors";
import {
  getFlag,
  requireFlagIdentifier,
  SEMANTIC_DIR,
  ENTITIES_DIR,
  detectDBType,
  cliProfileLogger,
} from "../../lib/cli-utils";
import type { ParsedEntity, GlossaryTerm, AuditPattern, AnalysisResult } from "@atlas/api/lib/semantic/expert";
import { applyAmendmentToEntity } from "../../lib/improve/apply-amendment";
import { createSnapshot } from "../../lib/migrate";

export async function handleImprove(args: string[]): Promise<void> {
  const isInteractive = args.includes("-i") || args.includes("--interactive");
  const isDryRun = !args.includes("--apply");

  if (isInteractive && args.includes("--apply")) {
    console.error(
      pc.red("Cannot use --interactive and --apply together. Interactive mode applies changes inline."),
    );
    process.exit(1);
  }

  const sinceArg = getFlag(args, "--since");
  const minConfidenceArg = getFlag(args, "--min-confidence");
  const entitiesArg = getFlag(args, "--entities");
  const sourceArg = requireFlagIdentifier(args, "--source", "source name");

  // Parse --min-confidence
  const minConfidence = minConfidenceArg ? parseFloat(minConfidenceArg) : 0.5;
  if (Number.isNaN(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    console.error(
      pc.red(`Invalid --min-confidence: "${minConfidenceArg}". Must be a number between 0 and 1.`),
    );
    process.exit(1);
  }

  // Parse --entities
  const entityFilter = entitiesArg
    ? new Set(entitiesArg.split(",").map((e) => e.trim().toLowerCase()))
    : null;

  // Parse --since
  if (sinceArg) {
    const sinceDate = new Date(sinceArg);
    if (Number.isNaN(sinceDate.getTime())) {
      console.error(
        pc.red(`Invalid --since: "${sinceArg}". Expected ISO 8601 format (e.g., 2026-03-01).`),
      );
      process.exit(1);
    }
  }

  // Resolve directories
  const semanticRoot = sourceArg ? path.join(SEMANTIC_DIR, sourceArg) : SEMANTIC_DIR;
  const entitiesDir = sourceArg ? path.join(semanticRoot, "entities") : ENTITIES_DIR;

  // Validate semantic layer exists
  if (!fs.existsSync(entitiesDir)) {
    console.error(
      pc.red(`No entities found at ${entitiesDir}. Run 'atlas init' first.`),
    );
    process.exit(1);
  }

  // Validate datasource
  if (!process.env.ATLAS_DATASOURCE_URL) {
    console.error(pc.red("ATLAS_DATASOURCE_URL is required for atlas improve."));
    console.error("  Set ATLAS_DATASOURCE_URL=postgresql://... to enable profiling.");
    process.exit(1);
  }

  console.log(`\n${pc.bold("Atlas Improve")} — analyzing semantic layer for improvements...\n`);

  // 1. Load entities
  const entities: ParsedEntity[] = [];
  const entityFiles = fs.readdirSync(entitiesDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  for (const file of entityFiles) {
    try {
      const content = fs.readFileSync(path.join(entitiesDir, file), "utf-8");
      const parsed = yaml.load(content) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") continue;

      const entity: ParsedEntity = {
        name: (parsed.table as string) ?? path.basename(file, path.extname(file)),
        table: (parsed.table as string) ?? path.basename(file, path.extname(file)),
        description: parsed.description as string | undefined,
        dimensions: (parsed.dimensions as ParsedEntity["dimensions"]) ?? [],
        measures: (parsed.measures as ParsedEntity["measures"]) ?? [],
        joins: (parsed.joins as ParsedEntity["joins"]) ?? [],
        query_patterns: (parsed.query_patterns as ParsedEntity["query_patterns"]) ?? [],
        connection: parsed.connection as string | undefined,
      };

      if (entityFilter && !entityFilter.has(entity.name.toLowerCase())) continue;
      entities.push(entity);
    } catch (err) {
      console.warn(pc.yellow(`  Warning: Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // Load glossary
  const glossary: GlossaryTerm[] = [];
  const glossaryPath = path.join(semanticRoot, "glossary.yml");
  if (fs.existsSync(glossaryPath)) {
    try {
      const content = fs.readFileSync(glossaryPath, "utf-8");
      const parsed = yaml.load(content) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.terms)) {
        for (const term of parsed.terms) {
          if (term && typeof term === "object") {
            glossary.push(term as GlossaryTerm);
          }
        }
      }
    } catch {
      // intentionally ignored: glossary is optional
      console.debug("Failed to parse glossary.yml — skipping glossary analysis");
    }
  }

  console.log(`  Loaded ${pc.bold(String(entities.length))} entities, ${pc.bold(String(glossary.length))} glossary terms`);

  // 2. Profile tables
  const { profilePostgres } = await import("@atlas/api/lib/profiler");
  const dbType = detectDBType(process.env.ATLAS_DATASOURCE_URL);

  let profiles;
  if (dbType === "postgres") {
    const schema = getFlag(args, "--schema") ?? "public";
    const filterTables = entities.map((e) => e.table);
    const result = await profilePostgres(
      process.env.ATLAS_DATASOURCE_URL,
      filterTables,
      undefined,
      schema,
      undefined,
      cliProfileLogger,
    );
    profiles = result.profiles;
    if (result.errors.length > 0) {
      console.warn(pc.yellow(`  ${result.errors.length} table(s) failed to profile`));
    }
  } else {
    console.error(pc.red(`atlas improve currently supports PostgreSQL only (detected: ${dbType}).`));
    process.exit(1);
  }

  console.log(`  Profiled ${pc.bold(String(profiles.length))} tables`);

  // 3. Fetch audit log patterns (if internal DB available)
  const auditPatterns: AuditPattern[] = [];
  const rejectedKeys = new Set<string>();

  if (process.env.DATABASE_URL) {
    const { getInternalDB, closeInternalDB } = await import("@atlas/api/lib/db/internal");
    try {
      getInternalDB(); // Ensure connection is initialized

      const { internalQuery } = await import("@atlas/api/lib/db/internal");

      // Fetch audit patterns
      const auditParams: unknown[] = [];
      let sinceClause = "";
      if (sinceArg) {
        auditParams.push(sinceArg);
        sinceClause = `AND timestamp >= $${auditParams.length}::timestamptz`;
      }
      const auditRows = await internalQuery<{
        sql: string;
        count: string;
        last_seen: string;
        tables_accessed: string | string[] | null;
      }>(
        `SELECT sql, COUNT(*) AS count, MAX(timestamp) AS last_seen, tables_accessed
         FROM audit_log
         WHERE success = true AND deleted_at IS NULL ${sinceClause}
         GROUP BY sql, tables_accessed
         HAVING COUNT(*) >= 2
         ORDER BY COUNT(*) DESC
         LIMIT 200`,
        auditParams,
      );

      for (const row of auditRows) {
        let tables: string[] = [];
        try {
          if (typeof row.tables_accessed === "string") {
            tables = JSON.parse(row.tables_accessed) as string[];
          } else if (Array.isArray(row.tables_accessed)) {
            tables = row.tables_accessed;
          }
        } catch {
          // intentionally ignored: malformed tables_accessed
        }
        auditPatterns.push({
          sql: row.sql,
          count: parseInt(String(row.count), 10),
          tables,
          lastSeen: String(row.last_seen),
        });
      }

      console.log(`  Analyzed ${pc.bold(String(auditPatterns.length))} audit log patterns`);

      // Fetch rejected proposals
      const rejectedRows = await internalQuery<{
        source_entity: string;
        amendment_payload: string | Record<string, unknown> | null;
      }>(
        `SELECT source_entity, amendment_payload FROM learned_patterns
         WHERE type = 'semantic_amendment' AND status = 'rejected'
         AND reviewed_at >= now() - interval '30 days'`,
        [],
      );

      for (const row of rejectedRows) {
        try {
          const payload = typeof row.amendment_payload === "string"
            ? JSON.parse(row.amendment_payload)
            : row.amendment_payload;
          if (payload && payload.amendmentType) {
            rejectedKeys.add(`${row.source_entity}:${payload.amendmentType}:${payload.amendment?.name ?? ""}`);
          }
        } catch {
          // intentionally ignored: malformed payload
        }
      }

      await closeInternalDB();
    } catch (err) {
      console.warn(
        pc.yellow(`  Warning: Could not access internal DB: ${err instanceof Error ? err.message : String(err)}`),
      );
      try {
        const { closeInternalDB } = await import("@atlas/api/lib/db/internal");
        await closeInternalDB();
      } catch {
        // intentionally ignored: cleanup failure
      }
    }
  } else {
    console.log(pc.dim("  No DATABASE_URL — skipping audit log analysis"));
  }

  // 4. Run analysis engine
  const { analyzeSemanticLayer } = await import("@atlas/api/lib/semantic/expert");

  const results = analyzeSemanticLayer({
    profiles,
    entities,
    glossary,
    auditPatterns,
    rejectedKeys,
  });

  // Filter by min confidence
  const filtered = results.filter((r) => r.confidence >= minConfidence);

  console.log(
    `\nFound ${pc.bold(String(filtered.length))} improvements` +
      (minConfidence > 0 ? ` (filtered by confidence >= ${minConfidence})` : "") +
      ":\n",
  );

  if (filtered.length === 0) {
    console.log(pc.green("Your semantic layer looks good! No improvements found above the confidence threshold."));
    return;
  }

  // 5. Interactive mode — present proposals one at a time
  if (isInteractive) {
    const { runInteractiveSession } = await import("../../lib/improve/interactive");
    await runInteractiveSession({ entitiesDir, proposals: filtered });
    return;
  }

  // 5b. Batch mode — output all proposals
  for (let i = 0; i < filtered.length; i++) {
    const r = filtered[i];
    printProposal(i + 1, r);
  }

  // 6. Apply or store proposals
  if (!isDryRun) {
    // Auto-snapshot before applying changes
    try {
      const entry = createSnapshot(semanticRoot, {
        message: `Pre-improve snapshot (${filtered.length} amendments)`,
        trigger: "improve",
      });
      if (entry) {
        console.log(pc.dim(`  Snapshot ${entry.hash} created before applying changes`));
      }
    } catch (err) {
      console.warn(pc.yellow(`  Warning: Could not create snapshot: ${err instanceof Error ? err.message : String(err)}`));
    }

    console.log(`\n${pc.bold("Applying changes...")}\n`);

    let applied = 0;
    let failed = 0;

    for (const r of filtered) {
      const entityPath = path.join(entitiesDir, `${r.entityName}.yml`);
      if (!fs.existsSync(entityPath)) {
        console.warn(pc.yellow(`  Skip: ${r.entityName}.yml not found`));
        failed++;
        continue;
      }

      try {
        const content = fs.readFileSync(entityPath, "utf-8");
        const entity = yaml.load(content) as Record<string, unknown>;

        const { updated, warning } = applyAmendmentToEntity(entity, r);
        if (warning) {
          console.warn(pc.yellow(`  Warning: ${warning}`));
        }

        const updatedYaml = yaml.dump(updated, { lineWidth: 120, noRefs: true });
        fs.writeFileSync(entityPath, updatedYaml, "utf-8");
        console.log(pc.green(`  Applied: [${r.amendmentType}] ${r.entityName}`));
        applied++;
      } catch (err) {
        console.error(pc.red(`  Failed: ${r.entityName}: ${err instanceof Error ? err.message : String(err)}`));
        failed++;
      }
    }

    console.log(
      `\n${pc.green(`Applied ${applied} change(s)`)}`
      + (failed > 0 ? `, ${pc.red(`${failed} failed`)}` : ""),
    );
  } else {
    console.log(pc.dim("\nDry run — no files modified. Use --apply to write changes."));
  }

  // 7. Write to internal DB if available
  if (process.env.DATABASE_URL && filtered.length > 0) {
    try {
      const { getInternalDB, closeInternalDB, insertSemanticAmendment } = await import(
        "@atlas/api/lib/db/internal"
      );
      getInternalDB();

      let stored = 0;
      for (const r of filtered) {
        try {
          await insertSemanticAmendment({
            orgId: null, // CLI runs in single-org mode
            description: `[${r.amendmentType}] ${r.entityName}: ${r.rationale}`,
            sourceEntity: r.entityName,
            confidence: r.confidence,
            amendmentPayload: {
              entityName: r.entityName,
              amendmentType: r.amendmentType,
              amendment: r.amendment,
              rationale: r.rationale,
              diff: "", // CLI doesn't generate diffs for stored proposals
              confidence: r.confidence,
              ...(r.testQuery && { testQuery: r.testQuery }),
            },
          });
          stored++;
        } catch (err) {
          console.debug(`Failed to store proposal: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      console.log(pc.dim(`\nStored ${stored} proposal(s) in learned_patterns table for admin review.`));
      await closeInternalDB();
    } catch (err) {
      console.debug(`Failed to store proposals: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function printProposal(index: number, r: AnalysisResult): void {
  const confidencePct = Math.round(r.confidence * 100);
  const scoreLabel = r.score >= 0.5 ? pc.green(`${r.score}`) : pc.yellow(`${r.score}`);

  console.log(
    `${pc.bold(`${index}.`)} [${pc.cyan(r.entityName)}] ${formatAmendmentType(r.amendmentType)}`,
  );
  console.log(`   ${r.rationale}`);
  console.log(
    `   Confidence: ${confidencePct}%  Score: ${scoreLabel}  Category: ${r.category}`,
  );

  // Show amendment details
  const amendment = r.amendment as Record<string, unknown>;
  if (amendment.name) {
    console.log(`   Name: ${pc.bold(String(amendment.name))}`);
  }
  if (amendment.sql) {
    console.log(`   SQL: ${pc.dim(String(amendment.sql))}`);
  }
  if (amendment.description && amendment.description !== amendment.name) {
    console.log(`   Description: ${String(amendment.description)}`);
  }

  if (r.testQuery) {
    console.log(`   Test: ${pc.dim(r.testQuery)}`);
  }
  console.log();
}

function formatAmendmentType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

