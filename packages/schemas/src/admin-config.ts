/**
 * Admin config wire-format schemas.
 *
 * - `WorkspaceBranding` — `/api/v1/admin/branding` (GET / POST)
 * - `WorkspaceModelConfig` — `/api/v1/admin/model-config` (GET / POST)
 * - `PIIColumnClassification` — `/api/v1/admin/compliance/pii` (list / update)
 * - `SemanticDiffResponse` — `/api/v1/admin/semantic/diff`
 *
 * PII classifications tighten `category` / `confidence` / `maskingStrategy`
 * to their canonical tuples (`PII_CATEGORIES` / `PII_CONFIDENCE_LEVELS` /
 * `MASKING_STRATEGIES`) so server-side enum additions propagate to the
 * route OpenAPI and the web parse without a second edit.
 *
 * Timestamp fields (`createdAt` / `updatedAt`) go through
 * `IsoTimestampSchema` (#1697).
 */
import { z } from "zod";
import {
  MASKING_STRATEGIES,
  MODEL_CONFIG_PROVIDERS,
  PII_CATEGORIES,
  PII_CONFIDENCE_LEVELS,
  type PIIColumnClassification,
  type SemanticDiffResponse,
  type WorkspaceBranding,
  type WorkspaceModelConfig,
} from "@useatlas/types";
import { IsoTimestampSchema } from "./common";

// ---------------------------------------------------------------------------
// Workspace branding
// ---------------------------------------------------------------------------

export const WorkspaceBrandingSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  logoUrl: z.string().nullable(),
  logoText: z.string().nullable(),
  primaryColor: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  hideAtlasBranding: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}) satisfies z.ZodType<WorkspaceBranding, unknown>;

// ---------------------------------------------------------------------------
// Workspace model config
// ---------------------------------------------------------------------------

export const WorkspaceModelConfigSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  provider: z.enum(MODEL_CONFIG_PROVIDERS),
  model: z.string(),
  baseUrl: z.string().nullable(),
  apiKeyMasked: z.string(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}) satisfies z.ZodType<WorkspaceModelConfig, unknown>;

// ---------------------------------------------------------------------------
// PII classification
// ---------------------------------------------------------------------------

export const PIIColumnClassificationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  tableName: z.string(),
  columnName: z.string(),
  connectionId: z.string(),
  category: z.enum(PII_CATEGORIES),
  confidence: z.enum(PII_CONFIDENCE_LEVELS),
  maskingStrategy: z.enum(MASKING_STRATEGIES),
  reviewed: z.boolean(),
  dismissed: z.boolean(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}) satisfies z.ZodType<PIIColumnClassification, unknown>;

// ---------------------------------------------------------------------------
// Semantic diff
// ---------------------------------------------------------------------------

const SemanticTableDiffSchema = z.object({
  table: z.string(),
  addedColumns: z.array(z.object({ name: z.string(), type: z.string() })),
  removedColumns: z.array(z.object({ name: z.string(), type: z.string() })),
  typeChanges: z.array(
    z.object({ name: z.string(), yamlType: z.string(), dbType: z.string() }),
  ),
});

export const SemanticDiffResponseSchema = z.object({
  connection: z.string(),
  newTables: z.array(z.string()),
  removedTables: z.array(z.string()),
  tableDiffs: z.array(SemanticTableDiffSchema),
  unchangedCount: z.number(),
  summary: z.object({
    total: z.number(),
    new: z.number(),
    removed: z.number(),
    changed: z.number(),
    unchanged: z.number(),
  }),
  warnings: z.array(z.string()).optional(),
}) satisfies z.ZodType<SemanticDiffResponse, unknown>;
