/**
 * proposeAmendment tool — propose a semantic layer YAML change with rationale.
 *
 * Generates a unified YAML diff, optionally runs a test query, and writes the
 * proposal to the learned_patterns table for admin review.
 */

import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { loadYaml } from "../semantic/yaml";
import { createTwoFilesPatch } from "diff";
import { hasInternalDB, insertSemanticAmendment } from "@atlas/api/lib/db/internal";
import { createLogger, getRequestContext } from "@atlas/api/lib/logger";
import { runUserQueryPipeline } from "@atlas/api/lib/tools/sql";
import type { AmendmentPayload } from "@useatlas/types";
import type { AnalysisResult } from "@atlas/api/lib/semantic/expert/types";
import { getSemanticRoot } from "@atlas/api/lib/semantic/files";

const log = createLogger("tool:propose-amendment");

export const proposeAmendment = tool({
  description: `Propose a semantic layer YAML change. Generates a unified diff and writes to the review queue.

Amendment types: add_dimension, add_measure, add_join, add_query_pattern, update_description, update_dimension, add_glossary_term, add_virtual_dimension.

The amendment object should match the YAML structure for that type (e.g., { name, sql, type, description } for a dimension).`,

  inputSchema: z.object({
    entityName: z.string().describe("Entity (table) name to amend"),
    amendmentType: z.enum([
      "add_dimension",
      "add_measure",
      "add_join",
      "add_query_pattern",
      "update_description",
      "update_dimension",
      "add_glossary_term",
      "add_virtual_dimension",
    ]),
    amendment: z
      .record(z.string(), z.unknown())
      .describe("Type-specific amendment payload matching the YAML structure"),
    rationale: z
      .string()
      .describe("Why this change improves the semantic layer"),
    testQuery: z
      .string()
      .optional()
      .describe("Optional SQL to validate the amendment"),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe("Confidence this amendment is correct (0.0–1.0)"),
  }),

  execute: async ({
    entityName,
    amendmentType,
    amendment,
    rationale,
    testQuery,
    confidence,
  }) => {
    try {
      // Content scope for this turn: the org + Connection group the request
      // resolves entities against (#2345). Threaded into the baseline read so
      // the diff is computed against the SAME document approval will mutate.
      const orgId = getRequestContext()?.user?.activeOrganizationId ?? null;
      const connectionGroupId = getRequestContext()?.connectionGroupId;

      // Load the current entity baseline.
      //
      // When an internal DB is present (SaaS + self-hosted-with-DB), entities
      // live in `semantic_entities` — org entities and group entities are
      // ABSENT from the flat disk root (ADR-0012). Read them through the SAME
      // org/group-aware resolver the apply path uses, so the diff the admin
      // reviews describes exactly what approval writes (#4488). The resolved
      // `targetGroupId` is the row's OWN group — threaded into the auto-approve
      // apply below so the write lands in the scope the diff was computed from.
      let entity: Record<string, unknown>;
      let applyGroupId: string | null = null;

      if (hasInternalDB()) {
        const { resolveAmendmentBaseline } = await import(
          "@atlas/api/lib/semantic/expert/apply"
        );
        const baseline = await resolveAmendmentBaseline(
          orgId,
          entityName,
          connectionGroupId,
        );
        entity = baseline.parsed;
        applyGroupId = baseline.targetGroupId;
      } else {
        // No internal DB (self-hosted preview only): entities live on disk in
        // the flat root and the apply path never runs (the DB-backed insert +
        // apply seam below is skipped), so there is no diff-vs-apply scope to
        // reconcile. Read the flat-root mirror for the preview.
        const entityPath = path.join(getSemanticRoot(), "entities", `${entityName}.yml`);
        if (!fs.existsSync(entityPath)) {
          return {
            error: `Entity file not found: ${entityPath}. Check that the entity name matches a YAML file in the semantic layer.`,
          };
        }
        // `loadYaml` returns undefined for an empty file (v5 would throw),
        // routing it into the tailored "empty or malformed" error below.
        const raw = loadYaml(fs.readFileSync(entityPath, "utf-8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return {
            error: `Entity file ${entityName}.yml could not be parsed as a YAML mapping. The file may be empty or malformed.`,
          };
        }
        entity = raw as Record<string, unknown>;
      }

      // Apply the amendment through the SAME authoritative mutation the apply
      // path uses (upsertByIdentity, throw-on-missing-target) — no divergent
      // local copy that could preview a clean append where apply replaces, or
      // "no change" where apply errors (#4488).
      const { applyAmendment } = await import("@atlas/api/lib/semantic/expert/apply");
      const updated = applyAmendment(entity, {
        category: "coverage_gaps",
        entityName,
        group: connectionGroupId ?? "default",
        amendmentType,
        amendment,
        rationale,
        impact: 0,
        confidence,
        staleness: 0,
        score: 0,
      } satisfies AnalysisResult);

      // Normalize both sides through yaml.dump() with identical options so
      // the diff only shows actual content changes, not formatting drift
      // (e.g. inline arrays → multiline, whitespace differences).
      const dumpOpts: yaml.DumpOptions = {
        lineWidth: 120,
        noRefs: true,
        quoteStyle: "double",
      };
      const beforeNormalized = yaml.dump(entity, dumpOpts);
      const afterYaml = yaml.dump(updated, dumpOpts);

      // Generate diff — LCS-based algorithm produces proper multi-hunk unified diffs
      const filePath = `semantic/entities/${entityName}.yml`;
      const diff = createTwoFilesPatch(filePath, filePath, beforeNormalized, afterYaml, "", "", { context: 3 });

      // Run test query if provided — route through the full production
      // pipeline (validation → approval → RLS → auto-LIMIT → audit + masking),
      // exactly like validateProposal (#3338). NEVER a raw `db.query`: the old
      // path validated against the default datasource but executed against the
      // org connection, skipping RLS, the auto-LIMIT row cap, and PII masking,
      // then persisted the raw, unmasked rows into
      // learned_patterns.amendment_payload — an RLS bypass + unbounded-scan +
      // unmasked-data-at-rest vector (#4485). The persisted `sampleRows` below
      // are therefore the pipeline's masked, capped output.
      let testResult: AmendmentPayload["testResult"];
      if (testQuery) {
        const outcome = await runUserQueryPipeline({
          sql: testQuery,
          connectionId: "default",
          explanation: `Semantic amendment proposal test query (${entityName})`,
        });

        if (outcome.kind === "ok") {
          testResult = {
            success: true,
            rowCount: outcome.rowCount,
            // Masked, auto-LIMITed pipeline output — capped at 5 for the
            // review UI. These are the rows persisted into amendment_payload.
            sampleRows: outcome.rows.slice(0, 5),
          };
        } else {
          // Any non-ok outcome (validation_failed, approval_required, rls_failed,
          // …) fails closed: no rows are captured or persisted.
          testResult = {
            success: false,
            rowCount: 0,
            sampleRows: [],
            error: outcome.message,
          };
          log.warn(
            { testQuery, kind: outcome.kind, error: outcome.message },
            "Amendment test query blocked or failed in the query pipeline",
          );
        }
      }

      // Build payload
      const payload: AmendmentPayload = {
        entityName,
        amendmentType,
        amendment,
        rationale,
        diff,
        confidence,
        ...(testQuery && { testQuery }),
        ...(testResult && { testResult }),
      };

      // Write to review queue if internal DB available
      let proposalId: string;
      let status: "queued" | "auto_approved";

      if (hasInternalDB()) {
        const result = await insertSemanticAmendment({
          orgId,
          description: `[${amendmentType}] ${entityName}: ${rationale}`,
          sourceEntity: entityName,
          confidence,
          amendmentPayload: payload as unknown as Record<string, unknown>,
          // Persist the group the baseline was resolved from (the row's OWN
          // `connection_group_id`) so a HUMAN-reviewed approve — which applies
          // with the stored row's group via `applyAmendmentFromPayload`, the
          // seam every admin approve path shares — targets the same row this
          // diff was computed against, instead of falling back to unscoped
          // resolution (409 on ambiguous names) (#4498).
          connectionGroupId: applyGroupId,
        });

        // Permanent rejection memory (#4507): the identity was previously
        // rejected by an admin. Surface WHY so the model stops re-proposing it
        // — the row is not re-queued and nothing is applied.
        if (result.outcome === "rejected") {
          return {
            status: "rejected",
            reason:
              "This change was previously rejected by an admin and will not be re-queued. Rejection memory is permanent — do not re-propose the same amendment unless the admin reconsiders it.",
            diff,
          };
        }

        // Pending dedup (#4507): an identical change is already awaiting
        // review. Point the model at the existing proposal instead of queuing
        // a duplicate; the diff is unchanged, so nothing new is applied.
        if (result.outcome === "already_pending") {
          return {
            proposalId: result.id,
            status: "already_pending",
            diff,
            ...(testResult && { testResult }),
          };
        }

        proposalId = result.id;

        if (result.status === "approved") {
          // Auto-approve resolved this to `approved` at insert time. `approved`
          // is terminal for the pending queue, so — exactly like the scheduler
          // path (semantic/expert/scheduler.ts) — we MUST apply it now, or the
          // row claims applied while the semantic layer is unchanged and the
          // diff shown to the user is fiction (#4486). On apply failure, revert
          // the row to `pending` so the invariant "status='approved' ⇒ applied"
          // holds and an admin still sees the proposal in the review queue.
          try {
            // Dynamic imports (matching the scheduler + admin approve path):
            // keeps the apply/revert seam out of this tool's static graph, so
            // the many partial `mock.module("…/db/internal")` test stubs that
            // don't exercise the auto-approve branch don't have to add the
            // export just to link.
            const { applyAmendmentFromPayload } = await import(
              "@atlas/api/lib/semantic/expert/apply"
            );
            await applyAmendmentFromPayload({
              orgId,
              sourceEntity: entityName,
              // Thread the SAME group the baseline was resolved from (the
              // resolved row's own `connection_group_id`) so approval writes
              // the scope the diff was computed against — never the flat/NULL
              // default for an org/group-scoped entity (#4488).
              connectionGroupId: applyGroupId,
              // `rawPayload` is typed `unknown`, so the AmendmentPayload passes
              // through directly (matches the admin approve call sites).
              rawPayload: payload,
              requestId: getRequestContext()?.requestId ?? `propose-${Date.now()}`,
              label: proposalId,
            });
            status = "auto_approved";
          } catch (applyErr) {
            // Surface the failure: revert the row so it never lingers as
            // `approved`-but-unapplied, and log — never swallow.
            const { revertAmendmentToPending } = await import(
              "@atlas/api/lib/db/internal"
            );
            const reverted = await revertAmendmentToPending(proposalId).catch(
              (revertErr: unknown) => {
                log.error(
                  {
                    err: revertErr instanceof Error ? revertErr.message : String(revertErr),
                    proposalId,
                    entityName,
                  },
                  "Failed to revert auto-approved amendment to pending after apply failure — row may remain approved-but-unapplied",
                );
                return false;
              },
            );
            log.warn(
              {
                err: applyErr instanceof Error ? applyErr.message : String(applyErr),
                entityName,
                amendmentType,
                proposalId,
                reverted,
              },
              "Auto-approved amendment failed to apply — reverted to pending for admin review",
            );
            status = "queued";
          }
        } else {
          status = "queued";
        }
      } else {
        proposalId = `local-${Date.now()}`;
        status = "queued";
      }

      return {
        proposalId,
        status,
        diff,
        ...(testResult && { testResult }),
      };
    } catch (err) {
      log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          entityName,
          amendmentType,
          requestId: getRequestContext()?.requestId,
        },
        "proposeAmendment failed",
      );
      return {
        error: `Failed to propose amendment: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
