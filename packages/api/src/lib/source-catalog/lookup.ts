/**
 * Impure loader that assembles the {@link buildSourceCatalog} input for a
 * workspace and renders the Source-catalog system-prompt block (ADR-0022 §4,
 * slice (b) #3894).
 *
 * Lives alongside the pure builder but in its own file so the format stays
 * testable without a DB — the same split `group-reach/` uses (`resolveReach` ↔
 * `loadVisibleGroups`) and `learn/org-knowledge-section.ts` (builder ↔ resolver).
 *
 * It folds three already-established sources into one menu:
 *   - **SQL Connection groups** — the workspace's *visible* groups (content-mode /
 *     whitelist-filtered, via {@link loadVisibleGroups}), each annotated with its
 *     headline entity names (from {@link listEntities}) and its routing
 *     description ({@link getGroupDescriptionMap}: operator-refined or the
 *     auto-generated seed; absent → the builder's entity-name fallback).
 *   - **REST datasources** — handed in by the agent loop (it has already resolved
 *     the conversation-scoped set), as a minimal shape so this module never
 *     imports the openapi types.
 *
 * Never throws — every failure degrades to an empty block (logged, per CLAUDE.md
 * "never silently swallow errors") rather than costing the agent its turn. An
 * empty result means "no catalog" and the caller appends nothing.
 *
 * @see ADR-0022 — cross-group reach + Source catalog
 * @see issue #3894 — slice (b) acceptance criteria
 */

import * as yaml from "js-yaml";
import { createLogger } from "@atlas/api/lib/logger";
import { loadVisibleGroups } from "@atlas/api/lib/group-reach/lookup";
import { resolveReach, type ReachState } from "@atlas/api/lib/group-reach";
import {
  getGroupDescriptionMap,
  upsertAutoGroupDescription,
} from "@atlas/api/lib/db/connection-group-descriptions";
import {
  buildSourceCatalog,
  deriveGroupDescription,
  type CatalogSource,
  type SourceCatalogOptions,
} from "./index";

const log = createLogger("source-catalog:lookup");

/**
 * Minimal REST datasource projection for the catalog. The agent loop maps its
 * resolved `RestDatasource[]` into this so the loader stays decoupled from the
 * openapi graph types.
 */
export interface RestCatalogSource {
  /** Install id — the `executeRestOperation` `datasourceId`. */
  readonly id: string;
  /** Display name for the entry. */
  readonly displayName: string;
  /** Headline operation ids (bounded + summarized by the builder). */
  readonly operationNames: readonly string[];
}

/**
 * Render the Source-catalog block for a workspace, or `""` when there is nothing
 * to route between (no workspace, no visible SQL groups, and no REST datasources).
 *
 * `reach` (#3895, ADR-0022) narrows the SQL half to the conversation's reachable
 * groups: under `all` (the default) every visible group is listed; under `focus`
 * only the focused group is — so the menu the agent reads matches what
 * `executeSQL` will actually allow, instead of advertising groups every query to
 * which would be rejected. REST datasources are a separate axis (REST scope,
 * ADR-0011) and are never narrowed by SQL reach.
 */
export async function loadSourceCatalog(
  orgId: string | undefined,
  mode: "published" | "developer" | undefined,
  restDatasources: readonly RestCatalogSource[] = [],
  options: SourceCatalogOptions = {},
  reach: ReachState = { kind: "all" },
): Promise<string> {
  const restSources: CatalogSource[] = restDatasources.map((ds) => ({
    kind: "rest",
    id: ds.id,
    name: ds.displayName,
    entities: ds.operationNames,
  }));

  // No workspace ⇒ no enumerable SQL groups (the self-hosted single-connection
  // case). REST may still be present, so render whatever we were handed.
  if (!orgId) {
    return buildSourceCatalog(restSources, options);
  }

  let sqlSources: CatalogSource[] = [];
  try {
    const [visibleGroups, descriptions, entityNamesByGroup] = await Promise.all([
      loadVisibleGroups(orgId, mode),
      getGroupDescriptionMap(orgId),
      loadEntityNamesByGroup(orgId, mode),
    ]);

    // #3895 — narrow to the reachable groups: under Focus the catalog lists only
    // the focused group (a `focus`-on-invisible reach resolves to none, so the
    // catalog drops the SQL half entirely rather than listing an unreachable
    // group). Under `all` this is every visible group, unchanged.
    const reachableGroups = resolveReach(reach, visibleGroups).reachableGroups;

    sqlSources = reachableGroups.map((grp) => ({
      kind: "sql",
      id: grp.id,
      // Groups have no separate display name post-0096 — the id IS the name.
      name: grp.id,
      description: descriptions.get(grp.id) ?? undefined,
      entities: entityNamesByGroup.get(grp.id) ?? [],
    }));
  } catch (err) {
    // Degrade to REST-only rather than dropping the whole turn's catalog.
    log.warn(
      { err: err instanceof Error ? err.message : String(err), orgId },
      "Source catalog: SQL group assembly failed — rendering REST datasources only",
    );
  }

  return buildSourceCatalog([...sqlSources, ...restSources], options);
}

/**
 * Auto-generate and persist a Connection group's Source-catalog description from
 * the entity batch just saved for it (ADR-0022 §4 "auto-generated from the
 * group's entities at the semantic-generation seam"). Called from `/wizard/save`
 * after the entities land.
 *
 * Multi-member groups share one entity definition (a second member's save upserts
 * the same group rows), so the saved batch IS the group's entity set — deriving
 * from it matches deriving from the full group. Each entity's `name` /
 * `description` are read from its YAML (a parse failure skips just that entity,
 * never the batch). The write goes through {@link upsertAutoGroupDescription},
 * which never clobbers an operator's manual edit. Best-effort: returns silently
 * on an empty derivation (nothing to seed). Callers should still wrap in their
 * own error boundary — a description hiccup must not fail the save.
 */
export async function refreshGroupAutoDescription(
  orgId: string,
  groupId: string,
  entities: ReadonlyArray<{ readonly name: string; readonly yaml: string }>,
): Promise<void> {
  const input = entities.map((e) => {
    let description: string | null = null;
    let name = e.name;
    try {
      const parsed = yaml.load(e.yaml);
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.description === "string" && obj.description) description = obj.description;
        if (typeof obj.name === "string" && obj.name) name = obj.name;
      }
    } catch (err) {
      // Unparseable YAML → fall back to the table name with no description.
      // (Skipping the whole batch would lose the auto-seed for a one-off bad
      // row.) Logged at debug, not swallowed, so a systemic enrichment-pipeline
      // regression writing bad YAML is observable rather than silent.
      log.debug(
        { name: e.name, err: err instanceof Error ? err.message : String(err) },
        "Source catalog: failed to parse entity YAML for auto-description — using table name only",
      );
    }
    return { name, description };
  });

  const description = deriveGroupDescription(input);
  if (!description) return;
  await upsertAutoGroupDescription(orgId, groupId, description);
}

/**
 * Group the workspace's entity display names by their Connection group
 * (`source`). Best-effort: a failure means the builder falls back to descriptions
 * / "no entities", never an error. The dynamic import mirrors `group-reach/lookup`
 * — `entities.ts` is frequently partial-mocked, so a static import would pull it
 * into broad load graphs and break those fixtures.
 */
async function loadEntityNamesByGroup(
  orgId: string,
  mode: "published" | "developer" | undefined,
): Promise<Map<string, string[]>> {
  const { listEntities } = await import("@atlas/api/lib/semantic/entities");
  const entries = await listEntities({ orgId, mode });
  const byGroup = new Map<string, string[]>();
  for (const entry of entries) {
    const list = byGroup.get(entry.source) ?? [];
    list.push(entry.name);
    byGroup.set(entry.source, list);
  }
  return byGroup;
}
