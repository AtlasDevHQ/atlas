/**
 * The semantic-entity STORE as a drivable fixture — one registration covering
 * `@atlas/api/lib/semantic/entities`, `@atlas/api/lib/semantic` and
 * `@atlas/api/lib/semantic/sync`, every spy swappable per test.
 *
 * Every spy starts as the most neutral default (`getEntity` resolves `null`,
 * writes succeed, `createVersion` returns `"version-1"`), because the module
 * under test — `lib/semantic/expert/apply.ts` — needs a DIFFERENT baseline per
 * contract it carries (glossary routing, group scoping, dual-apply, snapshot
 * rollback), and a fixture that picked one of them would be wrong for the
 * rest. Each `describe` installs its own baseline in its own `beforeEach`;
 * `reset()` returns every spy to the default with an empty call log (see
 * `drivable.ts` for why that is not what bun's `mockReset()` does on its own).
 *
 * Two things are checked by the compiler rather than by convention:
 *
 * - every value export of the three modules is registered — the driven ones as
 *   spies, the rest as `notDriven` throwers that name themselves — and each
 *   factory is typed against the real module's export set (`keyof typeof
 *   Real…`, type-only imports), so a new export is a compile error here, not a
 *   link error in the suite that happens to reach it first;
 * - each spy's PARAMETER list is the real function's (`Parameters<typeof
 *   RealEntities.getEntity>`), so `.mock.calls[n][i]` assertions in a suite
 *   read the same positions the production caller passes. Only the RETURN type
 *   is the fixture's own: spies resolve `MockEntityRow`, the slice of a
 *   `semantic_entities` row the apply seam reads, because demanding
 *   `created_at` on every fixture row would be noise that proves nothing.
 *
 * @module
 */

import { mock } from "bun:test";
import type * as RealEntities from "@atlas/api/lib/semantic/entities";
import type * as RealSemantic from "@atlas/api/lib/semantic";
import type * as RealSync from "@atlas/api/lib/semantic/sync";
import { drivable, notDriven, type DrivableFn, type DrivableMock } from "./drivable";

/** The slice of a `semantic_entities` row the apply seam reads. */
export interface MockEntityRow {
  readonly id: string;
  /** Read by the dual-apply's draft-skip snapshot; optional for every other path. */
  readonly org_id?: string;
  readonly connection_group_id: string | null;
  /** `"draft_delete"` routes the dual-apply to its tombstone skip. */
  readonly status?: string;
  readonly yaml_content: string;
}

/**
 * Stand-in for the tagged error the route layer maps to 409. The apply code's
 * `instanceof AmbiguousEntityError` resolves against THIS class — it imports
 * the name from the mocked module — so a throw here is recognised. The
 * constructor takes the real class's fields, with the two the tests never
 * set left optional.
 */
export class AmbiguousEntityError extends Error {
  readonly _tag = "AmbiguousEntityError";
  readonly entityName: string;
  readonly entityType: string;
  readonly groups: ReadonlyArray<string | null>;
  constructor(opts: {
    message: string;
    entityName?: string;
    entityType?: string;
    groups: ReadonlyArray<string | null>;
  }) {
    super(opts.message);
    this.name = "AmbiguousEntityError";
    this.entityName = opts.entityName ?? "";
    this.entityType = opts.entityType ?? "entity";
    this.groups = opts.groups;
  }
}

/** A spy with the real function's parameters and the fixture's return type. */
type Driven<F extends DrivableFn, R> = DrivableMock<(...args: Parameters<F>) => R>;

function driven<F extends DrivableFn, R>(defaultImpl: (...args: Parameters<F>) => R): Driven<F, R> {
  return drivable(defaultImpl);
}

/** The spies a suite drives, keyed by the export name they stand in for. */
export interface SemanticStoreSpies {
  readonly getEntity: Driven<typeof RealEntities.getEntity, Promise<MockEntityRow | null>>;
  readonly upsertEntityForGroup: Driven<typeof RealEntities.upsertEntityForGroup, Promise<void>>;
  readonly createVersion: Driven<typeof RealEntities.createVersion, Promise<string>>;
  readonly generateChangeSummary: Driven<typeof RealEntities.generateChangeSummary, Promise<string>>;
  readonly getDraftEntityForGroup: Driven<
    typeof RealEntities.getDraftEntityForGroup,
    Promise<MockEntityRow | null>
  >;
  readonly upsertDraftEntityForGroup: Driven<typeof RealEntities.upsertDraftEntityForGroup, Promise<void>>;
  readonly invalidateOrgWhitelist: Driven<typeof RealSemantic.invalidateOrgWhitelist, void>;
  readonly syncEntityToDisk: Driven<typeof RealSync.syncEntityToDisk, Promise<void>>;
}

export interface SemanticStoreMock extends SemanticStoreSpies {
  /** The class the mocked module exports — throw it from `getEntity` to model a cross-group 409. */
  readonly AmbiguousEntityError: typeof AmbiguousEntityError;
  /** Every spy back to its default with an empty call log. Call from `beforeEach`. */
  readonly reset: () => void;
}

const FIXTURE = "semantic-store";

/** Register the three modules and return the handles. Call once, at the top of the file. */
export function installSemanticStoreMock(): SemanticStoreMock {
  const spies: SemanticStoreSpies = {
    getEntity: driven<typeof RealEntities.getEntity, Promise<MockEntityRow | null>>(async () => null),
    upsertEntityForGroup: driven<typeof RealEntities.upsertEntityForGroup, Promise<void>>(async () => {}),
    createVersion: driven<typeof RealEntities.createVersion, Promise<string>>(async () => "version-1"),
    generateChangeSummary: driven<typeof RealEntities.generateChangeSummary, Promise<string>>(
      async () => "summary",
    ),
    getDraftEntityForGroup: driven<typeof RealEntities.getDraftEntityForGroup, Promise<MockEntityRow | null>>(
      async () => null,
    ),
    upsertDraftEntityForGroup: driven<typeof RealEntities.upsertDraftEntityForGroup, Promise<void>>(
      async () => {},
    ),
    invalidateOrgWhitelist: driven<typeof RealSemantic.invalidateOrgWhitelist, void>(() => {}),
    syncEntityToDisk: driven<typeof RealSync.syncEntityToDisk, Promise<void>>(async () => {}),
  };

  const entitiesFactory = (): Record<keyof typeof RealEntities, unknown> => ({
    getEntity: spies.getEntity,
    upsertEntityForGroup: spies.upsertEntityForGroup,
    createVersion: spies.createVersion,
    generateChangeSummary: spies.generateChangeSummary,
    getDraftEntityForGroup: spies.getDraftEntityForGroup,
    upsertDraftEntityForGroup: spies.upsertDraftEntityForGroup,
    AmbiguousEntityError,
    SEMANTIC_ENTITY_STATUSES: ["published", "draft", "draft_delete", "archived"] as const,
    DEMO_CONNECTION_ID: "__demo__",
    listConnectionGroupMembers: notDriven("listConnectionGroupMembers", FIXTURE),
    resolveGroupIdForConnection: notDriven("resolveGroupIdForConnection", FIXTURE),
    upsertEntity: notDriven("upsertEntity", FIXTURE),
    upsertDraftEntity: notDriven("upsertDraftEntity", FIXTURE),
    upsertTombstone: notDriven("upsertTombstone", FIXTURE),
    upsertTombstoneForGroup: notDriven("upsertTombstoneForGroup", FIXTURE),
    deleteDraftEntity: notDriven("deleteDraftEntity", FIXTURE),
    deleteDraftEntityForGroup: notDriven("deleteDraftEntityForGroup", FIXTURE),
    listEntityRows: notDriven("listEntityRows", FIXTURE),
    listEntities: notDriven("listEntities", FIXTURE),
    listEntitiesWithOverlay: notDriven("listEntitiesWithOverlay", FIXTURE),
    deleteEntity: notDriven("deleteEntity", FIXTURE),
    countEntities: notDriven("countEntities", FIXTURE),
    listVersions: notDriven("listVersions", FIXTURE),
    getVersion: notDriven("getVersion", FIXTURE),
    applyTombstones: notDriven("applyTombstones", FIXTURE),
    promoteDraftEntities: notDriven("promoteDraftEntities", FIXTURE),
    archiveSingleConnection: notDriven("archiveSingleConnection", FIXTURE),
    restoreSingleConnection: notDriven("restoreSingleConnection", FIXTURE),
    bulkUpsertEntities: notDriven("bulkUpsertEntities", FIXTURE),
    upsertProfileStatus: notDriven("upsertProfileStatus", FIXTURE),
    listIncompleteProfileLayers: notDriven("listIncompleteProfileLayers", FIXTURE),
  });

  const semanticFactory = (): Record<keyof typeof RealSemantic, unknown> => ({
    invalidateOrgWhitelist: spies.invalidateOrgWhitelist,
    SemanticLayerScanError: class SemanticLayerScanError extends Error {},
    getWhitelistedTables: notDriven("getWhitelistedTables", FIXTURE),
    getWhitelistedTablesStrict: notDriven("getWhitelistedTablesStrict", FIXTURE),
    getCrossSourceJoins: notDriven("getCrossSourceJoins", FIXTURE),
    registerPluginEntities: notDriven("registerPluginEntities", FIXTURE),
    _resetWhitelists: notDriven("_resetWhitelists", FIXTURE),
    loadOrgWhitelist: notDriven("loadOrgWhitelist", FIXTURE),
    getOrgWhitelistedTables: notDriven("getOrgWhitelistedTables", FIXTURE),
    invalidateOrgSemanticIndex: notDriven("invalidateOrgSemanticIndex", FIXTURE),
    getOrgSemanticIndex: notDriven("getOrgSemanticIndex", FIXTURE),
  });

  const syncFactory = (): Record<keyof typeof RealSync, unknown> => ({
    syncEntityToDisk: spies.syncEntityToDisk,
    getSemanticRoot: notDriven("getSemanticRoot", FIXTURE),
    syncEntityDeleteFromDisk: notDriven("syncEntityDeleteFromDisk", FIXTURE),
    syncAllEntitiesToDisk: notDriven("syncAllEntitiesToDisk", FIXTURE),
    cleanupOrgDirectory: notDriven("cleanupOrgDirectory", FIXTURE),
    invalidateOrgModeRoots: notDriven("invalidateOrgModeRoots", FIXTURE),
    invalidateOrgKnowledgeSubtree: notDriven("invalidateOrgKnowledgeSubtree", FIXTURE),
    ensureOrgModeSemanticRoot: notDriven("ensureOrgModeSemanticRoot", FIXTURE),
    _resetModeBuildCache: notDriven("_resetModeBuildCache", FIXTURE),
    importFromDisk: notDriven("importFromDisk", FIXTURE),
    reconcileAllOrgs: notDriven("reconcileAllOrgs", FIXTURE),
  });

  // Factories MUST be synchronous — bun's loader deadlocks on an async
  // `mock.module` factory that awaits internally.
  void mock.module("@atlas/api/lib/semantic/entities", entitiesFactory);
  void mock.module("@atlas/api/lib/semantic", semanticFactory);
  void mock.module("@atlas/api/lib/semantic/sync", syncFactory);

  return {
    ...spies,
    AmbiguousEntityError,
    reset: () => {
      for (const spy of Object.values(spies)) spy.reset();
    },
  };
}
