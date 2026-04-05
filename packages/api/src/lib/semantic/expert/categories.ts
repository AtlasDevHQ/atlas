/**
 * Analysis category functions — 9 pure functions that detect improvement opportunities.
 *
 * Each function takes an AnalysisContext and returns AnalysisResult[].
 */

import { mapSQLType } from "@atlas/api/lib/profiler-utils";
import { suggestMeasureType, describeMeasure } from "@atlas/api/lib/profiler-patterns";
import type { AnalysisContext, AnalysisResult, ParsedEntity } from "./types";
import { createAnalysisResult, tableFrequencyImpact } from "./scoring";

// ── Helpers ──────────────────────────────────────────────────────

function rejectionKey(entity: string, type: string, name?: string): string {
  return `${entity}:${type}${name ? `:${name}` : ""}`;
}

function stalenessFactor(entity: string, type: string, name: string | undefined, rejectedKeys: Set<string>): number {
  return rejectedKeys.has(rejectionKey(entity, type, name)) ? 0.8 : 0;
}

function findEntityForTable(entities: ParsedEntity[], tableName: string): ParsedEntity | undefined {
  return entities.find((e) => e.table === tableName || e.name === tableName);
}

const AUTO_DESC_PATTERN = /^The \w+ column\.?$|^Column \w+\.?$/i;

const NUMERIC_SQL_TYPES = new Set([
  "integer", "int", "smallint", "bigint", "serial", "bigserial",
  "real", "double precision", "float", "decimal", "numeric",
  "money", "int2", "int4", "int8", "float4", "float8",
]);

// ── 1. Coverage Gaps ─────────────────────────────────────────────

export function findCoverageGaps(ctx: AnalysisContext): AnalysisResult[] {
  const results: AnalysisResult[] = [];

  for (const profile of ctx.profiles) {
    const entity = findEntityForTable(ctx.entities, profile.table_name);
    if (!entity) continue;

    const dimNames = new Set(entity.dimensions.map((d) => d.sql.toLowerCase()));

    for (const col of profile.columns) {
      if (col.is_primary_key) continue; // PKs are usually not needed as dimensions
      if (dimNames.has(col.name.toLowerCase())) continue;

      const staleness = stalenessFactor(entity.name, "add_dimension", col.name, ctx.rejectedKeys);
      const impact = 0.6;
      const confidence = col.null_count !== null && col.unique_count !== null ? 0.7 : 0.5;

      results.push(createAnalysisResult({
        category: "coverage_gaps",
        entityName: entity.name,
        amendmentType: "add_dimension",
        amendment: {
          name: col.name,
          sql: col.name,
          type: mapSQLType(col.type),
          description: `The ${col.name.replace(/_/g, " ")} column`,
          ...(col.sample_values.length > 0 && { sample_values: col.sample_values.slice(0, 5) }),
        },
        rationale: `Column "${col.name}" exists in ${profile.table_name} but is not represented as a dimension in the entity schema.`,
        impact,
        confidence,
        staleness,
      }));
    }
  }

  return results;
}

// ── 2. Description Quality ───────────────────────────────────────

export function findDescriptionIssues(ctx: AnalysisContext): AnalysisResult[] {
  const results: AnalysisResult[] = [];

  for (const entity of ctx.entities) {
    // Table-level description
    if (!entity.description || AUTO_DESC_PATTERN.test(entity.description)) {
      const staleness = stalenessFactor(entity.name, "update_description", "table", ctx.rejectedKeys);
      const impact = 0.5;
      const confidence = 0.6;

      results.push(createAnalysisResult({
        category: "description_quality",
        entityName: entity.name,
        amendmentType: "update_description",
        amendment: { field: "table", description: entity.description ?? "" },
        rationale: entity.description
          ? `Table description "${entity.description}" appears auto-generated. A human-written description improves agent accuracy.`
          : `Table "${entity.name}" has no description. Adding one helps the agent understand when to use this entity.`,
        impact,
        confidence,
        staleness,
      }));
    }

    // Dimension-level descriptions
    for (const dim of entity.dimensions) {
      if (!dim.description || AUTO_DESC_PATTERN.test(dim.description)) {
        const staleness = stalenessFactor(entity.name, "update_description", dim.name, ctx.rejectedKeys);
        const impact = 0.4;
        const confidence = 0.6;

        results.push(createAnalysisResult({
          category: "description_quality",
          entityName: entity.name,
          amendmentType: "update_description",
          amendment: { dimension: dim.name, description: dim.description ?? "" },
          rationale: dim.description
            ? `Dimension "${dim.name}" description appears auto-generated.`
            : `Dimension "${dim.name}" has no description.`,
          impact,
          confidence,
          staleness,
        }));
      }
    }
  }

  return results;
}

// ── 3. Type Accuracy ─────────────────────────────────────────────

export function findTypeInaccuracies(ctx: AnalysisContext): AnalysisResult[] {
  const results: AnalysisResult[] = [];

  for (const profile of ctx.profiles) {
    const entity = findEntityForTable(ctx.entities, profile.table_name);
    if (!entity) continue;

    for (const dim of entity.dimensions) {
      const col = profile.columns.find((c) => c.name === dim.sql);
      if (!col) continue;

      const inferredType = mapSQLType(col.type);
      if (inferredType !== dim.type && inferredType !== "string") {
        const staleness = stalenessFactor(entity.name, "update_dimension", dim.name, ctx.rejectedKeys);
        const impact = 0.7;
        const confidence = 0.8;

        results.push(createAnalysisResult({
          category: "type_accuracy",
          entityName: entity.name,
          amendmentType: "update_dimension",
          amendment: { name: dim.name, type: inferredType },
          rationale: `Dimension "${dim.name}" is typed as "${dim.type}" but the database column is ${col.type} (maps to "${inferredType}").`,
          impact,
          confidence,
          staleness,
        }));
      }
    }
  }

  return results;
}

// ── 4. Missing Measures ──────────────────────────────────────────

export function findMissingMeasures(ctx: AnalysisContext): AnalysisResult[] {
  const results: AnalysisResult[] = [];

  for (const profile of ctx.profiles) {
    const entity = findEntityForTable(ctx.entities, profile.table_name);
    if (!entity) continue;

    const existingMeasureSqls = new Set(
      entity.measures.map((m) => m.sql.toLowerCase()),
    );

    for (const col of profile.columns) {
      if (!NUMERIC_SQL_TYPES.has(col.type.toLowerCase())) continue;
      if (col.is_primary_key || col.is_foreign_key) continue;

      // Check if any measure already references this column
      const alreadyCovered = entity.measures.some(
        (m) => m.sql.toLowerCase().includes(col.name.toLowerCase()),
      );
      if (alreadyCovered) continue;

      const suggestion = suggestMeasureType(col);
      if (suggestion === "count_where") continue; // Not a standard numeric measure

      const aggType = suggestion === "avg" ? "avg" : "sum";
      const measureName = `total_${col.name}`;

      if (existingMeasureSqls.has(col.name.toLowerCase())) continue;

      const staleness = stalenessFactor(entity.name, "add_measure", measureName, ctx.rejectedKeys);
      const impact = tableFrequencyImpact(profile.table_name, ctx.auditPatterns);
      const confidence = 0.65;
      const desc = describeMeasure(col, aggType);

      results.push(createAnalysisResult({
        category: "missing_measures",
        entityName: entity.name,
        amendmentType: "add_measure",
        amendment: {
          name: measureName,
          sql: aggType === "sum" ? col.name : col.name,
          type: aggType,
          description: desc,
        },
        rationale: `Numeric column "${col.name}" (${col.type}) has no measure. A ${aggType.toUpperCase()} measure would enable aggregation queries.`,
        testQuery: `SELECT ${aggType.toUpperCase()}("${col.name}") FROM "${profile.table_name}" LIMIT 1`,
        impact,
        confidence,
        staleness,
      }));
    }
  }

  return results;
}

// ── 5. Missing Joins ─────────────────────────────────────────────

export function findMissingJoins(ctx: AnalysisContext): AnalysisResult[] {
  const results: AnalysisResult[] = [];

  for (const profile of ctx.profiles) {
    const entity = findEntityForTable(ctx.entities, profile.table_name);
    if (!entity) continue;

    const existingJoinTables = new Set(
      entity.joins.map((j) => {
        // Extract target table from join SQL like "table_a.col = table_b.col"
        const match = j.sql.match(/(\w+)\.\w+\s*=\s*(\w+)\.\w+/);
        if (!match) return "";
        return match[1] === profile.table_name ? match[2] : match[1];
      }).filter(Boolean).map((t) => t.toLowerCase()),
    );

    // Check declared foreign keys
    for (const fk of [...profile.foreign_keys, ...profile.inferred_foreign_keys]) {
      if (existingJoinTables.has(fk.to_table.toLowerCase())) continue;

      // Verify target table has an entity
      const targetEntity = findEntityForTable(ctx.entities, fk.to_table);
      if (!targetEntity) continue;

      const joinSql = `${profile.table_name}.${fk.from_column} = ${fk.to_table}.${fk.to_column}`;
      const staleness = stalenessFactor(entity.name, "add_join", fk.to_table, ctx.rejectedKeys);
      const impact = 0.8;
      const confidence = fk.source === "constraint" ? 0.95 : 0.6;

      results.push(createAnalysisResult({
        category: "missing_joins",
        entityName: entity.name,
        amendmentType: "add_join",
        amendment: {
          name: `to_${fk.to_table}`,
          sql: joinSql,
          description: `${profile.table_name}.${fk.from_column} → ${fk.to_table}.${fk.to_column}`,
        },
        rationale: `Foreign key relationship from ${profile.table_name}.${fk.from_column} to ${fk.to_table}.${fk.to_column} is not captured as a join in the entity schema.`,
        testQuery: `SELECT COUNT(*) FROM "${profile.table_name}" INNER JOIN "${fk.to_table}" ON ${joinSql} LIMIT 1`,
        impact,
        confidence,
        staleness,
      }));
    }
  }

  return results;
}

// ── 6. Glossary Gaps ─────────────────────────────────────────────

export function findGlossaryGaps(ctx: AnalysisContext): AnalysisResult[] {
  const results: AnalysisResult[] = [];
  const glossaryTerms = new Set(ctx.glossary.map((g) => g.term.toLowerCase()));

  // Look for common business abbreviations in column names
  const BUSINESS_ABBREVS = /(?:^|_)(acv|arr|mrr|churn|ltv|cac|nps|dau|mau|wau|gmv|arpu|aov|ctr|cvr|roi|roas)(?:_|$)/i;

  for (const entity of ctx.entities) {
    for (const dim of entity.dimensions) {
      const matches = dim.name.match(BUSINESS_ABBREVS);
      if (!matches) continue;

      const abbrev = matches[1].toLowerCase();
      if (glossaryTerms.has(abbrev)) continue;

      const staleness = stalenessFactor(entity.name, "add_glossary_term", abbrev, ctx.rejectedKeys);
      const impact = 0.5;
      const confidence = 0.5;

      results.push(createAnalysisResult({
        category: "glossary_gaps",
        entityName: entity.name,
        amendmentType: "add_glossary_term",
        amendment: { term: abbrev, definition: "", ambiguous: true },
        rationale: `Business abbreviation "${abbrev}" appears in column "${dim.name}" but is not defined in the glossary. Defining it helps the agent understand queries about this metric.`,
        impact,
        confidence,
        staleness,
      }));
    }
  }

  return results;
}

// ── 7. Sample Value Staleness ────────────────────────────────────

export function findStaleSampleValues(ctx: AnalysisContext): AnalysisResult[] {
  const results: AnalysisResult[] = [];

  for (const profile of ctx.profiles) {
    const entity = findEntityForTable(ctx.entities, profile.table_name);
    if (!entity) continue;

    for (const dim of entity.dimensions) {
      if (!dim.sample_values || dim.sample_values.length === 0) continue;

      const col = profile.columns.find((c) => c.name === dim.sql);
      if (!col || col.sample_values.length === 0) continue;

      // Check how many declared samples still exist in actual data
      const actualSet = new Set(col.sample_values.map((v) => String(v).toLowerCase()));
      const staleValues = dim.sample_values.filter(
        (v) => !actualSet.has(String(v).toLowerCase()),
      );

      if (staleValues.length === 0) continue;

      const staleness = stalenessFactor(entity.name, "update_dimension", dim.name, ctx.rejectedKeys);
      const impact = 0.3;
      const confidence = 0.85;

      results.push(createAnalysisResult({
        category: "sample_value_staleness",
        entityName: entity.name,
        amendmentType: "update_dimension",
        amendment: {
          name: dim.name,
          sample_values: col.sample_values.slice(0, 10),
        },
        rationale: `${staleValues.length} of ${dim.sample_values.length} declared sample values for "${dim.name}" no longer appear in the data: ${staleValues.slice(0, 3).join(", ")}${staleValues.length > 3 ? "..." : ""}`,
        impact,
        confidence,
        staleness,
      }));
    }
  }

  return results;
}

// ── 8. Query Pattern Coverage ────────────────────────────────────

export function findQueryPatternGaps(ctx: AnalysisContext): AnalysisResult[] {
  const results: AnalysisResult[] = [];

  // Only works with audit log data
  if (ctx.auditPatterns.length === 0) return results;

  for (const entity of ctx.entities) {
    const existingPatternSqls = new Set(
      entity.query_patterns.map((p) => p.sql.trim().toLowerCase()),
    );

    // Find frequent audit patterns that touch this entity's table
    const relevantPatterns = ctx.auditPatterns
      .filter((p) => p.tables.includes(entity.table))
      .filter((p) => p.count >= 3) // At least 3 occurrences
      .filter((p) => !existingPatternSqls.has(p.sql.trim().toLowerCase()));

    for (const pattern of relevantPatterns.slice(0, 3)) {
      const staleness = stalenessFactor(entity.name, "add_query_pattern", undefined, ctx.rejectedKeys);
      const impact = Math.min(1, pattern.count / 20); // 20+ queries = max impact
      const confidence = 0.7;

      results.push(createAnalysisResult({
        category: "query_pattern_coverage",
        entityName: entity.name,
        amendmentType: "add_query_pattern",
        amendment: {
          name: `pattern_${entity.table}_${results.length}`,
          description: `Frequently executed query pattern (${pattern.count} occurrences)`,
          sql: pattern.sql.length > 500 ? pattern.sql.slice(0, 500) + "..." : pattern.sql,
        },
        rationale: `This query pattern has been executed ${pattern.count} times involving table "${entity.table}" but is not captured in query_patterns.`,
        impact,
        confidence,
        staleness,
      }));
    }
  }

  return results;
}

// ── 9. Virtual Dimension Opportunities ───────────────────────────

export function findVirtualDimensionOpportunities(ctx: AnalysisContext): AnalysisResult[] {
  const results: AnalysisResult[] = [];

  if (ctx.auditPatterns.length === 0) return results;

  // Common SQL expressions that suggest virtual dimensions
  const EXTRACT_PATTERN = /EXTRACT\s*\(\s*(\w+)\s+FROM\s+(\w+)\)/gi;
  const DATE_TRUNC_PATTERN = /DATE_TRUNC\s*\(\s*'(\w+)'\s*,\s*(\w+)\)/gi;

  for (const pattern of ctx.auditPatterns) {
    if (pattern.count < 3) continue;

    // Check for EXTRACT expressions
    for (const match of pattern.sql.matchAll(EXTRACT_PATTERN)) {
      const part = match[1].toLowerCase(); // e.g., "month", "year"
      const column = match[2].toLowerCase();

      for (const entity of ctx.entities) {
        if (!pattern.tables.includes(entity.table)) continue;

        const dim = entity.dimensions.find((d) => d.sql === column);
        if (!dim) continue;

        // Check if virtual dimension already exists
        const virtualName = `${column}_${part}`;
        const exists = entity.dimensions.some(
          (d) => d.name === virtualName && d.virtual,
        );
        if (exists) continue;

        const staleness = stalenessFactor(entity.name, "add_virtual_dimension", virtualName, ctx.rejectedKeys);
        const impact = Math.min(1, pattern.count / 10);
        const confidence = 0.75;

        results.push(createAnalysisResult({
          category: "virtual_dimension_opportunities",
          entityName: entity.name,
          amendmentType: "add_virtual_dimension",
          amendment: {
            name: virtualName,
            sql: `EXTRACT(${part.toUpperCase()} FROM ${column})`,
            type: "number",
            description: `${part.charAt(0).toUpperCase() + part.slice(1)} extracted from ${column}`,
          },
          rationale: `EXTRACT(${part.toUpperCase()} FROM ${column}) appears in ${pattern.count} queries. A virtual dimension would simplify these queries.`,
          testQuery: `SELECT EXTRACT(${part.toUpperCase()} FROM "${column}") FROM "${entity.table}" LIMIT 1`,
          impact,
          confidence,
          staleness,
        }));
      }
    }

    // Check for DATE_TRUNC expressions
    for (const match of pattern.sql.matchAll(DATE_TRUNC_PATTERN)) {
      const interval = match[1].toLowerCase();
      const column = match[2].toLowerCase();

      for (const entity of ctx.entities) {
        if (!pattern.tables.includes(entity.table)) continue;

        const dim = entity.dimensions.find((d) => d.sql === column);
        if (!dim) continue;

        const virtualName = `${column}_${interval}`;
        const exists = entity.dimensions.some(
          (d) => d.name === virtualName && d.virtual,
        );
        if (exists) continue;

        const staleness = stalenessFactor(entity.name, "add_virtual_dimension", virtualName, ctx.rejectedKeys);
        const impact = Math.min(1, pattern.count / 10);
        const confidence = 0.75;

        results.push(createAnalysisResult({
          category: "virtual_dimension_opportunities",
          entityName: entity.name,
          amendmentType: "add_virtual_dimension",
          amendment: {
            name: virtualName,
            sql: `DATE_TRUNC('${interval}', ${column})`,
            type: "timestamp",
            description: `${column} truncated to ${interval}`,
          },
          rationale: `DATE_TRUNC('${interval}', ${column}) appears in ${pattern.count} queries. A virtual dimension would simplify these queries.`,
          testQuery: `SELECT DATE_TRUNC('${interval}', "${column}") FROM "${entity.table}" LIMIT 1`,
          impact,
          confidence,
          staleness,
        }));
      }
    }
  }

  return results;
}
