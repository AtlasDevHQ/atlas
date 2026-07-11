/** Migration bundle types — wire format for `atlas-operator export` / `atlas import`. */

import type { MessageRole, Surface } from "./conversation";
import type { LearnedPattern } from "./learned-pattern";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** Bundle format version. Increment on breaking changes. */
export const EXPORT_BUNDLE_VERSION = 1;

/** Metadata header for an export bundle. */
export interface ExportManifest {
  version: typeof EXPORT_BUNDLE_VERSION;
  exportedAt: string;
  source: {
    /** Human-readable label for the source instance (e.g. "self-hosted"). */
    label: string;
    /** Base URL of the source Atlas API, if known. */
    apiUrl?: string;
  };
  counts: {
    conversations: number;
    messages: number;
    semanticEntities: number;
    learnedPatterns: number;
    settings: number;
  };
}

// ---------------------------------------------------------------------------
// Per-entity export shapes
// ---------------------------------------------------------------------------

/** Exported conversation — includes messages inline. */
export interface ExportedConversation {
  id: string;
  userId: string | null;
  title: string | null;
  surface: Surface;
  connectionId: string | null;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
  messages: ExportedMessage[];
}

/** Exported message within a conversation. */
export interface ExportedMessage {
  id: string;
  role: MessageRole;
  content: unknown;
  createdAt: string;
}

/** Exported semantic entity (DB-backed YAML). */
export interface ExportedSemanticEntity {
  name: string;
  entityType: string;
  yamlContent: string;
  /**
   * Group scope (multi-environment semantic layer, #2340). Three accepted
   * shapes:
   * - **omitted** — producer with no group concept (pre-1.4.4 bundle).
   *   Importers coalesce this to `null`.
   * - **explicit `null`** — 1.4.4+ unscoped row (global / no binding), or a
   *   bundle whose legacy `connectionId` no longer resolves to a live group.
   * - **explicit string** — group id. One entity row per group; multi-member
   *   groups share the same definition.
   *
   * Optional because strict shape validation on import would otherwise reject
   * producers that have no concept of the column. Value-nullability alone
   * wasn't enough — optionality is what makes the field additive on the wire.
   */
  connectionGroupId?: string | null;
}

/** Exported learned pattern. */
export interface ExportedLearnedPattern {
  patternSql: string;
  description: string | null;
  sourceEntity: string | null;
  confidence: number;
  status: LearnedPattern["status"];
  /**
   * Row type — `query_pattern` (default) or `semantic_amendment`. Carried so an
   * amendment survives workspace migration as an amendment instead of
   * round-tripping as an orphaned query pattern (#4569, audit M9). Optional for
   * backward-compat with pre-#4569 bundles (absent ⇒ `query_pattern`).
   */
  type?: LearnedPattern["type"];
  /**
   * The stored amendment envelope (entity, amendment type, diff, payload) for a
   * `semantic_amendment` row; `null`/absent for query patterns. Opaque
   * passthrough — carried verbatim from source jsonb to target so the
   * amendment's content survives the migration (#4569) without coupling the
   * bundle to a specific `AmendmentPayload` schema version. (Workspace
   * ownership is carried by `orgId` + `connectionGroupId`, not this envelope.)
   */
  amendmentPayload?: Record<string, unknown> | null;
  /** Connection group the row targets (ADR-0012); `null`/absent = default group. */
  connectionGroupId?: string | null;
  /** Reviewer attribution carried through the migration; `null`/absent if unreviewed. */
  reviewedBy?: string | null;
  /** Review timestamp (paired with `reviewedBy`); `null`/absent if unreviewed. */
  reviewedAt?: string | null;
  /** Observed repetition count — pattern/amendment strength; absent ⇒ 1. */
  repetitionCount?: number;
}

/** Exported setting key/value pair. */
export interface ExportedSetting {
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Full bundle
// ---------------------------------------------------------------------------

/** Complete export bundle — serialized as a single JSON file. */
export interface ExportBundle {
  manifest: ExportManifest;
  conversations: ExportedConversation[];
  semanticEntities: ExportedSemanticEntity[];
  learnedPatterns: ExportedLearnedPattern[];
  settings: ExportedSetting[];
}

// ---------------------------------------------------------------------------
// Import result
// ---------------------------------------------------------------------------

/** Summary returned by the import endpoint. */
export interface ImportResult {
  conversations: { imported: number; skipped: number };
  semanticEntities: { imported: number; skipped: number };
  learnedPatterns: { imported: number; skipped: number };
  settings: { imported: number; skipped: number };
}

// ---------------------------------------------------------------------------
// Cross-region migration phases
// ---------------------------------------------------------------------------

/** Phases of the cross-region data migration lifecycle. */
export const MIGRATION_PHASES = [
  "validating",
  "exporting",
  "transferring",
  "cutting_over",
  "scheduling_cleanup",
  "completed",
  "failed",
] as const;

export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

/** Grace period (in days) before source data is eligible for cleanup. */
export const CLEANUP_GRACE_PERIOD_DAYS = 7;
