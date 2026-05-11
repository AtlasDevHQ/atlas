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
  BEDROCK_REGIONS,
  GATEWAY_MODEL_TYPES,
  MASKING_STRATEGIES,
  MODEL_CONFIG_PROVIDERS,
  PII_CATEGORIES,
  PII_CONFIDENCE_LEVELS,
  type GatewayCatalogModel,
  type GatewayCatalogResponse,
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

export const API_KEY_STATUSES = ["masked", "platform_credits", "decrypt_failed"] as const;

export const WorkspaceModelConfigSchema = z
  .object({
    id: z.string(),
    orgId: z.string(),
    provider: z.enum(MODEL_CONFIG_PROVIDERS),
    model: z.string(),
    baseUrl: z.string().nullable(),
    bedrockRegion: z.enum(BEDROCK_REGIONS).nullable(),
    apiKeyMasked: z.string().nullable(),
    apiKeyStatus: z.enum(API_KEY_STATUSES),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  // Cross-field invariant: apiKeyMasked must be a non-null string iff status
  // is `masked`. `platform_credits` and `decrypt_failed` both imply null.
  .refine(
    (c) => (c.apiKeyStatus === "masked") === (c.apiKeyMasked !== null),
    {
      message:
        "apiKeyMasked must be non-null when apiKeyStatus='masked', and null otherwise",
      path: ["apiKeyMasked"],
    },
  )
  // `platform_credits` is only valid for the gateway provider — matches the
  // DB-side `chk_model_provider_key` invariant.
  .refine(
    (c) => c.apiKeyStatus !== "platform_credits" || c.provider === "gateway",
    {
      message: "apiKeyStatus='platform_credits' is only valid for provider='gateway'",
      path: ["apiKeyStatus"],
    },
  )
  // `bedrockRegion` is required for bedrock rows and must be null for every
  // other provider — matches the DB-side `chk_model_provider_region`
  // invariant added in migration 0057.
  .refine(
    (c) => (c.provider === "bedrock") === (c.bedrockRegion !== null),
    {
      message: "bedrockRegion is required for provider='bedrock' and must be null otherwise",
      path: ["bedrockRegion"],
    },
  ) satisfies z.ZodType<WorkspaceModelConfig, unknown>;

// ---------------------------------------------------------------------------
// Gateway catalog
// ---------------------------------------------------------------------------

export const GatewayCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  type: z.enum(GATEWAY_MODEL_TYPES),
  contextWindow: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  inputPrice: z.string().nullable(),
  outputPrice: z.string().nullable(),
  recommended: z.boolean(),
}) satisfies z.ZodType<GatewayCatalogModel, unknown>;

export const GatewayCatalogResponseSchema = z.object({
  models: z.array(GatewayCatalogModelSchema),
  fetchedAt: z.string(),
  fallback: z.boolean(),
}) satisfies z.ZodType<GatewayCatalogResponse, unknown>;

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
