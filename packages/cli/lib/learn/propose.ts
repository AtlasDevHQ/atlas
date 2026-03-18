/**
 * Proposal generator for `atlas learn`.
 *
 * Compares analysis results against existing semantic layer YAML files
 * and generates concrete proposals: new query patterns, join discoveries,
 * and glossary terms.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import type { AnalysisResult, ObservedJoin, ObservedPattern, ObservedAlias } from "./analyze";

// ── Types ──────────────────────────────────────────────────────────

export interface EntityYaml {
  name?: string;
  table: string;
  description?: string;
  dimensions?: Array<{ name: string; sql: string; type: string; description?: string; [k: string]: unknown }>;
  measures?: Array<{ name: string; sql: string; type: string; description?: string; [k: string]: unknown }>;
  joins?: Array<{ target_entity: string; relationship: string; join_columns: { from: string; to: string }; description?: string }>;
  query_patterns?: Array<{ description: string; sql: string }>;
  [key: string]: unknown;
}

export interface GlossaryYaml {
  terms: Record<string, {
    status: "defined" | "ambiguous";
    definition?: string;
    note?: string;
    possible_mappings?: string[];
  }>;
}

interface ProposalBase {
  /** File path being modified (entity YAML or glossary.yml). */
  filePath: string;
  /** Human-readable description. */
  description: string;
  /** Number of times this pattern was observed. */
  observedCount: number;
  /** The YAML content to add (serialized). */
  yamlAddition: string;
}

interface EntityProposal extends ProposalBase {
  type: "query_pattern" | "join";
  /** Table/entity this proposal applies to. */
  table: string;
  /** Apply this proposal to the entity YAML object in-memory. */
  apply: (entity: EntityYaml) => void;
}

interface GlossaryProposal extends ProposalBase {
  type: "glossary_term";
  table: null;
  /** Apply this proposal to the glossary YAML object in-memory. */
  apply: (glossary: GlossaryYaml) => void;
}

type Proposal = EntityProposal | GlossaryProposal;

export interface ProposalSet {
  proposals: Proposal[];
  /** Modified entity files: filePath → updated EntityYaml. */
  entityUpdates: Map<string, EntityYaml>;
  /** Updated glossary (null if no glossary changes). */
  glossaryUpdate: GlossaryYaml | null;
  glossaryPath: string | null;
}

// ── YAML loading ───────────────────────────────────────────────────

/**
 * Load all entity YAMLs from the entities directory.
 * Returns a map of table name (lowercase) → { filePath, entity }.
 */
export function loadEntities(entitiesDir: string): Map<string, { filePath: string; entity: EntityYaml }> {
  const result = new Map<string, { filePath: string; entity: EntityYaml }>();
  if (!fs.existsSync(entitiesDir)) return result;

  const files = fs.readdirSync(entitiesDir).filter((f) => f.endsWith(".yml"));
  for (const file of files) {
    const filePath = path.join(entitiesDir, file);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const entity = yaml.load(content) as EntityYaml;
      if (entity?.table) {
        result.set(entity.table.toLowerCase(), { filePath, entity });
      }
    } catch (err) {
      // Re-throw I/O errors (permissions, etc.); only skip YAML parse failures
      if (!(err instanceof yaml.YAMLException)) throw err;
      console.warn(`Warning: skipping ${file} — invalid YAML: ${err.message}`);
    }
  }
  return result;
}

/**
 * Load the glossary YAML if it exists.
 */
export function loadGlossary(semanticDir: string): { glossary: GlossaryYaml; filePath: string } | null {
  const filePath = path.join(semanticDir, "glossary.yml");
  if (!fs.existsSync(filePath)) return null;

  // Let I/O errors propagate — only the "file doesn't exist" case returns null
  const content = fs.readFileSync(filePath, "utf-8");
  const glossary = yaml.load(content) as GlossaryYaml;
  if (glossary?.terms) return { glossary, filePath };
  return null;
}

// ── Proposal generation ────────────────────────────────────────────

/**
 * Check if a query pattern is already defined in an entity's YAML.
 * Compares normalized SQL (whitespace-collapsed, lowercased).
 */
function patternExists(entity: EntityYaml, sql: string): boolean {
  if (!entity.query_patterns) return false;
  const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
  return entity.query_patterns.some(
    (p) => p.sql.replace(/\s+/g, " ").trim().toLowerCase() === normalized,
  );
}

/**
 * Check if a join to the target table already exists in the entity YAML.
 */
function joinExists(entity: EntityYaml, targetTable: string): boolean {
  if (!entity.joins) return false;
  const target = targetTable.toLowerCase();
  return entity.joins.some(
    (j) => j.target_entity.toLowerCase() === target,
  );
}

/**
 * Check if a glossary term already exists.
 */
function termExists(glossary: GlossaryYaml, term: string): boolean {
  return term.toLowerCase() in glossary.terms ||
    Object.keys(glossary.terms).some((k) => k.toLowerCase() === term.toLowerCase());
}

/**
 * Parse a JOIN ON clause to extract column references.
 * Handles simple cases like "table_a.col = table_b.col".
 */
function parseOnClause(onClause: string, fromTable: string, _toTable: string): { from: string; to: string } | null {
  // Match "a.col = b.col" equality patterns
  const match = onClause.match(
    /(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/i,
  );
  if (!match) return null;

  const leftTable = match[1] ?? "";
  const leftCol = match[2] ?? "";
  const rightTable = match[3] ?? "";
  const rightCol = match[4] ?? "";
  if (!leftTable || !leftCol || !rightTable || !rightCol) {
    return null;
  }
  if (leftTable.toLowerCase() === fromTable.toLowerCase()) {
    return { from: leftCol, to: rightCol };
  }
  if (rightTable.toLowerCase() === fromTable.toLowerCase()) {
    return { from: rightCol, to: leftCol };
  }
  // If table names don't match exactly, try by position
  return { from: leftCol, to: rightCol };
}

/**
 * Infer the entity name (PascalCase) from a table name.
 */
function inferEntityName(tableName: string): string {
  return tableName
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Maximum number of query pattern proposals per entity. */
const MAX_PATTERNS_PER_ENTITY = 5;

/**
 * Generate proposals by comparing analysis results against existing YAML.
 */
export function generateProposals(
  analysis: AnalysisResult,
  entities: Map<string, { filePath: string; entity: EntityYaml }>,
  glossaryData: { glossary: GlossaryYaml; filePath: string } | null,
): ProposalSet {
  const entityProposals: EntityProposal[] = [];
  const glossaryProposals: GlossaryProposal[] = [];

  // 1. Query pattern proposals
  proposeQueryPatterns(analysis.patterns, entities, entityProposals);

  // 2. Join discovery proposals
  proposeJoins(analysis.joins, entities, entityProposals);

  // 3. Glossary term proposals
  proposeGlossaryTerms(analysis.aliases, entities, glossaryData, glossaryProposals);

  const proposals: Proposal[] = [...entityProposals, ...glossaryProposals];

  // Build entity update map (deep clone entities that have proposals)
  const entityUpdates = new Map<string, EntityYaml>();
  let glossaryUpdate: GlossaryYaml | null = null;
  let glossaryPath: string | null = null;

  // Clone glossary upfront so proposals are applied to the clone, not the original.
  if (glossaryData && proposals.some((p) => p.type === "glossary_term")) {
    glossaryUpdate = structuredClone(glossaryData.glossary);
    glossaryPath = glossaryData.filePath;
  }

  for (const proposal of proposals) {
    if (proposal.type === "glossary_term") {
      if (glossaryUpdate) {
        proposal.apply(glossaryUpdate);
      }
    } else {
      const entry = entities.get(proposal.table);
      if (entry) {
        if (!entityUpdates.has(proposal.filePath)) {
          entityUpdates.set(proposal.filePath, structuredClone(entry.entity));
        }
        proposal.apply(entityUpdates.get(proposal.filePath)!);
      }
    }
  }

  return { proposals, entityUpdates, glossaryUpdate, glossaryPath };
}

function proposeQueryPatterns(
  patterns: ObservedPattern[],
  entities: Map<string, { filePath: string; entity: EntityYaml }>,
  proposals: EntityProposal[],
): void {
  const countsPerEntity = new Map<string, number>();

  for (const pattern of patterns) {
    const entry = entities.get(pattern.primaryTable);
    if (!entry) continue;

    // Skip if already defined
    if (patternExists(entry.entity, pattern.sql)) continue;

    // Limit per entity
    const count = countsPerEntity.get(pattern.primaryTable) ?? 0;
    if (count >= MAX_PATTERNS_PER_ENTITY) continue;
    countsPerEntity.set(pattern.primaryTable, count + 1);

    const patternEntry = {
      description: pattern.description,
      sql: pattern.sql,
    };

    proposals.push({
      type: "query_pattern",
      filePath: entry.filePath,
      table: pattern.primaryTable,
      description: `Add query pattern: "${pattern.description}" (observed ${pattern.count}x)`,
      observedCount: pattern.count,
      yamlAddition: yaml.dump([patternEntry], { lineWidth: -1 }).trim(),
      apply: (entity: EntityYaml) => {
        if (!entity.query_patterns) entity.query_patterns = [];
        entity.query_patterns.push(patternEntry);
      },
    });
  }
}

function proposeJoins(
  joins: Map<string, ObservedJoin>,
  entities: Map<string, { filePath: string; entity: EntityYaml }>,
  proposals: EntityProposal[],
): void {
  for (const [, join] of joins) {
    if (join.count < 2) continue; // Need at least 2 observations

    // Check both directions — propose the join on the "from" table
    for (const [sourceTable, targetTable] of [[join.fromTable, join.toTable], [join.toTable, join.fromTable]] as [string, string][]) {
      const entry = entities.get(sourceTable);
      if (!entry) continue;

      const targetEntry = entities.get(targetTable);
      const targetName = targetEntry?.entity.name ?? inferEntityName(targetTable);

      if (joinExists(entry.entity, targetName)) continue;

      let joinColumns: { from: string; to: string } | null = null;
      if (join.onClause) {
        joinColumns = parseOnClause(join.onClause, sourceTable, targetTable);
      }

      const joinEntry = {
        target_entity: targetName,
        relationship: "many_to_one",
        ...(joinColumns && {
          join_columns: joinColumns,
        }),
        description: `${sourceTable}.${joinColumns?.from ?? "?"} → ${targetTable}.${joinColumns?.to ?? "?"}`,
      };

      proposals.push({
        type: "join",
        filePath: entry.filePath,
        table: sourceTable,
        description: `Add join: ${sourceTable} → ${targetName} (observed ${join.count}x)`,
        observedCount: join.count,
        yamlAddition: yaml.dump([joinEntry], { lineWidth: -1 }).trim(),
        apply: (entity: EntityYaml) => {
          if (!entity.joins) entity.joins = [];
          entity.joins.push(joinEntry as EntityYaml["joins"] extends Array<infer T> ? T : never);
        },
      });
      break; // Only propose on one side
    }
  }
}

function proposeGlossaryTerms(
  aliases: ObservedAlias[],
  entities: Map<string, { filePath: string; entity: EntityYaml }>,
  glossaryData: { glossary: GlossaryYaml; filePath: string } | null,
  proposals: GlossaryProposal[],
): void {
  if (!glossaryData) return;

  for (const alias of aliases) {
    // Skip if it matches a column name in any entity (not interesting as a glossary term)
    let isColumnName = false;
    for (const [, entry] of entities) {
      if (entry.entity.dimensions?.some((d) => d.name === alias.alias)) {
        isColumnName = true;
        break;
      }
    }
    if (isColumnName) continue;

    // Skip if already in glossary
    if (termExists(glossaryData.glossary, alias.alias)) continue;

    // Skip very short aliases (e.g., "n", "v")
    if (alias.alias.length < 3) continue;

    const termEntry = {
      status: "defined" as const,
      definition: `Alias for ${alias.expression}. Used in queries on: ${alias.tables.join(", ")}.`,
    };

    proposals.push({
      type: "glossary_term",
      filePath: glossaryData.filePath,
      table: null,
      description: `Add glossary term: "${alias.alias}" = ${alias.expression} (observed ${alias.count}x)`,
      observedCount: alias.count,
      yamlAddition: yaml.dump({ [alias.alias]: termEntry }, { lineWidth: -1 }).trim(),
      apply: (glossary: GlossaryYaml) => {
        glossary.terms[alias.alias] = termEntry;
      },
    });
  }
}

// ── File writing ───────────────────────────────────────────────────

/**
 * Write updated entity and glossary YAML files to disk.
 * Returns written paths and any write failures (partial apply is possible).
 */
export function applyProposals(proposalSet: ProposalSet): { written: string[]; failed: Array<{ path: string; error: string }> } {
  const written: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  const dumpOpts = { lineWidth: -1, noRefs: true, sortKeys: false, quotingType: "'" as const };

  for (const [filePath, entity] of proposalSet.entityUpdates) {
    try {
      fs.writeFileSync(filePath, yaml.dump(entity, dumpOpts), "utf-8");
      written.push(filePath);
    } catch (err) {
      failed.push({ path: filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (proposalSet.glossaryUpdate && proposalSet.glossaryPath) {
    try {
      fs.writeFileSync(proposalSet.glossaryPath, yaml.dump(proposalSet.glossaryUpdate, dumpOpts), "utf-8");
      written.push(proposalSet.glossaryPath);
    } catch (err) {
      failed.push({ path: proposalSet.glossaryPath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { written, failed };
}
