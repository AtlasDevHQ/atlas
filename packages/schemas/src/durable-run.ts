/**
 * Durable agent-run status wire schema (#3749, ADR-0020) — SSOT for the API
 * route validation + web response parsing of the latest-run-status probe.
 *
 * Uses `satisfies z.ZodType<T>` (not `as`) so a field drifting from the
 * `@useatlas/types` shape is a compile error.
 */
import { z } from "zod";
import type { RunStatusResponse } from "@useatlas/types";

/** The four `agent_runs.status` lifecycle values plus the `none` sentinel. */
export const RunStatusValueSchema = z.enum(["running", "parked", "done", "failed", "none"]);

/** Response shape of `GET /api/v1/chat/{conversationId}/run-status`. */
export const RunStatusResponseSchema = z.object({
  status: RunStatusValueSchema,
  runId: z.string().optional(),
  parkedReason: z.string().nullable().optional(),
}) satisfies z.ZodType<RunStatusResponse, unknown>;
