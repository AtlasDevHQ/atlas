/**
 * atlas learn -- Analyze audit log and propose semantic layer YAML improvements.
 *
 * Extracted from atlas.ts to reduce monolith size.
 */

import * as fs from "fs";
import * as path from "path";
import pc from "picocolors";
import {
  getFlag,
  requireFlagIdentifier,
  SEMANTIC_DIR,
  ENTITIES_DIR,
} from "../../lib/cli-utils";

export async function handleLearn(args: string[]): Promise<void> {
  const applyMode = args.includes("--apply");
  const runSuggestions = args.includes("--suggestions");
  // Operators pass --auto-approve only when they explicitly want CLI-populated
  // rows to skip the /admin/starter-prompts moderation queue. Without the
  // flag, rows land as approval_status='pending' / status='draft' so an
  // admin can review before anything surfaces to end users.
  const autoApprove = args.includes("--auto-approve");
  const limitArg = getFlag(args, "--limit");
  const sinceArg = getFlag(args, "--since");
  const sourceArg = requireFlagIdentifier(args, "--source", "source name");

  if (autoApprove && !runSuggestions) {
    console.error(
      pc.red(
        "--auto-approve requires --suggestions (it only affects query suggestion rows).",
      ),
    );
    process.exit(1);
  }

  // Resolve semantic directories
  const semanticRoot = sourceArg
    ? path.join(SEMANTIC_DIR, sourceArg)
    : SEMANTIC_DIR;
  const entitiesDir = sourceArg
    ? path.join(semanticRoot, "entities")
    : ENTITIES_DIR;

  // Validate semantic layer exists
  if (!fs.existsSync(entitiesDir)) {
    console.error(
      pc.red(
        `No entities found at ${entitiesDir}. Run 'atlas init' first.`,
      ),
    );
    process.exit(1);
  }

  // Validate internal DB is configured
  if (!process.env.DATABASE_URL) {
    console.error(pc.red("DATABASE_URL is required for atlas learn."));
    console.error(
      "  The audit log is stored in the internal database.",
    );
    console.error(
      "  Set DATABASE_URL=postgresql://... to enable audit log analysis.",
    );
    process.exit(1);
  }

  // Validate --limit
  const limit = limitArg ? parseInt(limitArg, 10) : 1000;
  if (Number.isNaN(limit) || limit <= 0) {
    console.error(
      pc.red(
        `Invalid value for --limit: "${limitArg}". Expected a positive integer.`,
      ),
    );
    process.exit(1);
  }

  // Validate --since
  if (sinceArg) {
    const sinceDate = new Date(sinceArg);
    if (Number.isNaN(sinceDate.getTime())) {
      console.error(
        pc.red(
          `Invalid value for --since: "${sinceArg}". Expected ISO 8601 format (e.g., 2026-03-01).`,
        ),
      );
      process.exit(1);
    }
  }

  console.log(
    `\nAtlas Learn -- analyzing audit log for YAML improvements...\n`,
  );

  const { getInternalDB, closeInternalDB } = await import(
    "@atlas/api/lib/db/internal"
  );
  try {
    const { fetchAuditLog, analyzeQueries } = await import(
      "../../lib/learn/analyze"
    );
    const {
      loadEntities,
      loadGlossary,
      generateProposals,
      applyProposals,
    } = await import("../../lib/learn/propose");
    const { formatDiff, formatSummary } = await import(
      "../../lib/learn/diff"
    );

    // 1. Fetch audit log
    const pool = getInternalDB();
    const rows = await fetchAuditLog(pool, {
      limit,
      since: sinceArg,
    });

    if (rows.length === 0) {
      console.log(
        pc.yellow(
          "No successful queries found in the audit log.",
        ),
      );
      console.log("  Run some queries first, then try again.");
      return;
    }

    console.log(
      `  Analyzed ${pc.bold(String(rows.length))} successful queries`,
    );

    // 2. Analyze patterns
    const analysis = analyzeQueries(rows);
    console.log(
      `  Found ${pc.bold(String(analysis.patterns.length))} recurring patterns, ` +
        `${pc.bold(String(analysis.joins.size))} join pairs, ` +
        `${pc.bold(String(analysis.aliases.length))} column aliases`,
    );

    // 3. Load existing YAML
    const entities = loadEntities(entitiesDir);
    const glossaryData = loadGlossary(semanticRoot);

    if (entities.size === 0) {
      console.error(
        pc.red(
          `No valid entity YAML files found in ${entitiesDir}.`,
        ),
      );
      process.exit(1);
    }

    console.log(
      `  Comparing against ${pc.bold(String(entities.size))} entities\n`,
    );

    // 4. Generate proposals
    const proposalSet = generateProposals(
      analysis,
      entities,
      glossaryData,
    );

    // 5. Output results
    console.log(formatSummary(proposalSet));

    if (proposalSet.proposals.length > 0) {
      console.log(formatDiff(proposalSet));

      if (applyMode) {
        const { written, failed } = applyProposals(proposalSet);
        if (written.length > 0) {
          console.log(
            pc.green(
              `\n\u2713 Applied changes to ${written.length} file(s):`,
            ),
          );
          for (const f of written) {
            console.log(
              `  ${f.replace(process.cwd() + "/", "")}`,
            );
          }
        }
        if (failed.length > 0) {
          console.error(
            pc.red(
              `\n\u2717 Failed to write ${failed.length} file(s):`,
            ),
          );
          for (const f of failed) {
            console.error(
              `  ${f.path.replace(process.cwd() + "/", "")}: ${f.error}`,
            );
          }
          process.exit(1);
        }
      } else {
        console.log(
          pc.dim(
            "\nDry run -- no files modified. Use --apply to write changes.",
          ),
        );
      }
    }

    if (runSuggestions) {
      console.log(
        "\n\uD83D\uDCCA Generating query suggestions from audit log...",
      );
      const { generateSuggestions } = await import(
        "@atlas/api/lib/learn/suggestions"
      );
      // CLI runs in single-org mode. Pending-by-default keeps the admin
      // queue authoritative; --auto-approve is the documented escape hatch
      // for operators who want rows surfaced immediately.
      const result = await generateSuggestions(null, { autoApprove });
      console.log(
        `  Created: ${pc.bold(String(result.created))} suggestions`,
      );
      console.log(
        `  Updated: ${pc.bold(String(result.updated))} suggestions`,
      );
      if (autoApprove) {
        console.log(
          pc.yellow(
            "  \u2713 --auto-approve: new rows are approved+published (bypassed /admin/starter-prompts review)",
          ),
        );
      } else {
        console.log(
          pc.dim(
            "  New rows are pending review in /admin/starter-prompts. Pass --auto-approve to skip.",
          ),
        );
      }
    }
  } catch (err) {
    console.error(pc.red("Failed to analyze audit log."));
    console.error(
      `  ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  } finally {
    await closeInternalDB();
  }
}
