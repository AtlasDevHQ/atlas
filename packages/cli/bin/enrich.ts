#!/usr/bin/env tsx
/**
 * LLM-powered enrichment for auto-generated semantic layer YAMLs.
 *
 * Uses the Vercel AI SDK generateText() to add business context,
 * improved descriptions, query patterns, and derived metrics to
 * the YAML files produced by `bin/atlas.ts`.
 *
 * Called automatically by `bun run atlas -- init --enrich` when
 * an API key is available.
 */

import { generateText } from "ai";
import { getModel } from "@atlas/api/lib/providers";
import type { TableProfile } from "./atlas.js";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

const SEMANTIC_DIR = path.resolve("semantic");

// ---------------------------------------------------------------------------
// Token usage tracking
// ---------------------------------------------------------------------------

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function addUsage(accumulator: TokenUsage, usage: Partial<TokenUsage>): void {
  accumulator.promptTokens += usage.promptTokens ?? 0;
  accumulator.completionTokens += usage.completionTokens ?? 0;
  accumulator.totalTokens += usage.totalTokens ?? 0;
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

/**
 * Extract YAML content from an LLM response that wraps output in
 * ```yaml ... ``` code blocks.
 */
function extractYamlBlock(text: string): string {
  const match = text.match(/```yaml\s*\n([\s\S]*?)```/);
  if (match) return match[1].trim();

  // Fallback: try to parse the whole response as YAML
  console.warn("    Note: LLM response did not contain a ```yaml block, attempting to parse raw response");
  return text.trim();
}

/**
 * Safely parse YAML, returning null on failure.
 */
function safeParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = yaml.load(text);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch (err) {
    console.warn(`    YAML parse error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Deep-merge `source` into `target`. Arrays are replaced, not concatenated.
 * Only merges keys that exist in `source` and are non-null.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (val === null || val === undefined) continue;

    if (
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Profile formatting helpers
// ---------------------------------------------------------------------------

function formatTableProfile(profile: TableProfile): string {
  const lines: string[] = [];
  const label = profile.object_type === "view" ? "View" : "Table";
  lines.push(`${label}: ${profile.table_name}`);
  lines.push(`Row count: ${profile.row_count.toLocaleString()}`);

  if (profile.primary_key_columns.length > 0) {
    lines.push(`Primary key: ${profile.primary_key_columns.join(", ")}`);
  }

  if (profile.foreign_keys.length > 0) {
    lines.push("Foreign keys:");
    for (const fk of profile.foreign_keys) {
      lines.push(`  ${fk.from_column} -> ${fk.to_table}.${fk.to_column}`);
    }
  }

  lines.push("\nColumns:");
  for (const col of profile.columns) {
    const flags: string[] = [];
    if (col.is_primary_key) flags.push("PK");
    if (col.is_foreign_key) flags.push(`FK -> ${col.fk_target_table}.${col.fk_target_column}`);
    if (col.is_enum_like) flags.push("ENUM-LIKE");
    if (col.nullable) flags.push("nullable");

    const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
    const samples =
      col.sample_values.length > 0
        ? ` samples: ${col.sample_values.slice(0, 8).join(", ")}`
        : "";
    const stats: string[] = [];
    if (col.unique_count !== null) stats.push(`${col.unique_count} unique`);
    if (col.null_count !== null && col.null_count > 0)
      stats.push(`${col.null_count} nulls`);
    const statsStr = stats.length > 0 ? ` (${stats.join(", ")})` : "";

    lines.push(`  ${col.name}: ${col.type}${flagStr}${statsStr}${samples}`);
  }

  return lines.join("\n");
}

function formatAllTablesOverview(profiles: TableProfile[]): string {
  const lines: string[] = [];
  for (const p of profiles) {
    const label = p.object_type === "view" ? "View" : "Table";
    lines.push(`\n${label}: ${p.table_name} (${p.row_count} rows)`);
    for (const col of p.columns) {
      const typeInfo = col.is_enum_like ? `${col.type} [ENUM]` : col.type;
      lines.push(`  ${col.name}: ${typeInfo}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entity enrichment
// ---------------------------------------------------------------------------

async function enrichEntity(
  filePath: string,
  profile: TableProfile,
  model: ReturnType<typeof getModel>,
  usage: TokenUsage
): Promise<void> {
  const fileName = path.basename(filePath);
  console.log(`  Enriching ${fileName}...`);

  const existingContent = fs.readFileSync(filePath, "utf-8");
  const existingYaml = yaml.load(existingContent) as Record<string, unknown>;
  const profileText = formatTableProfile(profile);

  try {
    const result = await generateText({
      model,
      maxOutputTokens: 2000,
      prompt: `You are a data analyst enriching a semantic layer YAML file with business context.

Here is the table profile from the database:
${profileText}

Here is the current YAML definition:
\`\`\`yaml
${existingContent}
\`\`\`

Generate ONLY the following improved/new fields as valid YAML. Do not repeat the entire file.
Output your response inside a single \`\`\`yaml code block.

Required output fields:
1. **description**: A rich 2-3 sentence business description. Explain what business concept this table represents, what each row means, and how it relates to other tables.
2. **use_cases**: A list of 3-4 bullet strings. Include concrete analytical use cases and at least one "Avoid for X — use Y instead" entry.
3. **query_patterns**: A list of 2-3 objects, each with "description" (string) and "sql" (multiline SQL string). These should be common, useful queries that analysts would run against this table. Use proper PostgreSQL syntax.
4. **virtual_dimensions**: A list of suggested CASE-based bucketing dimensions for numeric columns and date extraction dimensions (year, month) for date/timestamp columns. Each should have: name, sql, type, description, virtual: true, and optionally sample_values. Only include if the table has suitable columns.

Output format:
\`\`\`yaml
description: |
  ...
use_cases:
  - ...
query_patterns:
  - description: ...
    sql: |
      ...
virtual_dimensions:
  - name: ...
    sql: |
      ...
    type: string
    description: ...
    virtual: true
\`\`\`

Important:
- Write concrete, actionable descriptions (not generic boilerplate)
- SQL must be valid PostgreSQL referencing only columns from the profile
- Do not invent columns that do not exist in the profile
- Use the table name "${profile.table_name}" in all SQL`,
    });

    addUsage(usage, result.usage);

    const yamlText = extractYamlBlock(result.text);
    const enriched = safeParse(yamlText);

    if (!enriched) {
      console.log(`    Warning: Could not parse LLM response for ${fileName}, skipping merge`);
      return;
    }

    // Merge enriched fields into existing YAML
    const merged = deepMerge(existingYaml, enriched);

    // Write back
    const output = yaml.dump(merged, { lineWidth: 120, noRefs: true });
    fs.writeFileSync(filePath, output);
    console.log(`    Updated ${fileName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`    Error enriching ${fileName}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Glossary enrichment
// ---------------------------------------------------------------------------

async function enrichGlossary(
  profiles: TableProfile[],
  model: ReturnType<typeof getModel>,
  usage: TokenUsage,
  semanticDir: string = SEMANTIC_DIR
): Promise<void> {
  const glossaryPath = path.join(semanticDir, "glossary.yml");
  if (!fs.existsSync(glossaryPath)) {
    console.log("  Skipping glossary enrichment (file not found)");
    return;
  }

  console.log("  Enriching glossary.yml...");

  const existingContent = fs.readFileSync(glossaryPath, "utf-8");
  const existingYaml = yaml.load(existingContent) as Record<string, unknown>;
  const tablesOverview = formatAllTablesOverview(profiles);

  try {
    const result = await generateText({
      model,
      maxOutputTokens: 1500,
      prompt: `You are a data analyst building a business glossary for a semantic layer.

Here are all the tables and columns in the database:
${tablesOverview}

Here is the current glossary:
\`\`\`yaml
${existingContent}
\`\`\`

Suggest additional glossary terms to add. Focus on:
1. **Ambiguous terms** — column names or business concepts that could mean different things depending on context. Mark these with status: "ambiguous" and include a "note" explaining the ambiguity and "possible_mappings" listing the options.
2. **Domain-specific definitions** — terms that need clear definitions for analysts. Mark these with status: "defined" and include a "definition".
3. **Disambiguation guidance** — for terms that overlap across tables, provide "disambiguation" text and "see_also" references.

Do NOT duplicate terms that already exist in the current glossary.
Output ONLY new terms as valid YAML inside a \`\`\`yaml code block.

Output format:
\`\`\`yaml
terms:
  term_name:
    status: defined|ambiguous
    definition: ...
    # or for ambiguous:
    note: ...
    possible_mappings:
      - ...
\`\`\`

Important:
- Only reference columns and tables that actually exist in the database
- Write concise, actionable definitions
- Include at least one ambiguous term if any exist`,
    });

    addUsage(usage, result.usage);

    const yamlText = extractYamlBlock(result.text);
    const enriched = safeParse(yamlText);

    if (!enriched) {
      console.log("    Warning: Could not parse LLM response for glossary, skipping merge");
      return;
    }

    // Merge new terms into existing glossary
    const existingTerms =
      (existingYaml.terms as Record<string, unknown>) ?? {};
    const newTerms =
      (enriched.terms as Record<string, unknown>) ?? {};

    // Only add terms that don't already exist
    const mergedTerms = { ...existingTerms };
    for (const [key, val] of Object.entries(newTerms)) {
      if (!(key in mergedTerms)) {
        mergedTerms[key] = val;
      }
    }

    const output = yaml.dump(
      { ...existingYaml, terms: mergedTerms },
      { lineWidth: 120, noRefs: true }
    );
    fs.writeFileSync(glossaryPath, output);
    console.log("    Updated glossary.yml");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`    Error enriching glossary: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Metrics enrichment
// ---------------------------------------------------------------------------

async function enrichMetric(
  filePath: string,
  profile: TableProfile,
  model: ReturnType<typeof getModel>,
  usage: TokenUsage
): Promise<void> {
  const fileName = path.basename(filePath);
  console.log(`  Enriching ${fileName}...`);

  const existingContent = fs.readFileSync(filePath, "utf-8");
  const existingYaml = yaml.load(existingContent) as Record<string, unknown>;
  const profileText = formatTableProfile(profile);

  try {
    const result = await generateText({
      model,
      maxOutputTokens: 2000,
      prompt: `You are a data analyst enriching metric definitions for a semantic layer.

Here is the table profile:
${profileText}

Here are the current metric definitions:
\`\`\`yaml
${existingContent}
\`\`\`

Suggest improvements and additions. Output ONLY the changes as valid YAML inside a \`\`\`yaml code block.

For existing metrics, add any missing fields:
- "unit" (e.g., "USD", "count", "percentage")
- "aggregation" (e.g., "sum", "avg", "count_distinct")
- "objective" (e.g., "maximize", "minimize", "maintain")

Also suggest 1-3 NEW derived metrics such as:
- Ratios (e.g., revenue per employee, value per account)
- Period-over-period comparisons (if date columns exist)
- Percentage breakdowns

Output format:
\`\`\`yaml
metrics:
  - id: existing_metric_id
    unit: USD
    aggregation: sum
    objective: maximize
  - id: new_derived_metric
    label: Descriptive Label
    description: What this metric measures and why it matters.
    type: derived
    sql: |
      SELECT ...
    unit: ...
    aggregation: ...
    objective: ...
\`\`\`

Important:
- For existing metrics, only output the id plus the NEW fields to add (not the entire metric)
- For new metrics, include all required fields (id, label, description, type, sql)
- SQL must be valid PostgreSQL referencing only columns from the profile
- Use the table name "${profile.table_name}" in all SQL
- Do not duplicate existing metric IDs for new metrics`,
    });

    addUsage(usage, result.usage);

    const yamlText = extractYamlBlock(result.text);
    const enriched = safeParse(yamlText);

    if (!enriched) {
      console.log(`    Warning: Could not parse LLM response for ${fileName}, skipping merge`);
      return;
    }

    // Merge: update existing metrics with new fields, append new metrics
    const existingMetrics = (existingYaml.metrics as Record<string, unknown>[]) ?? [];
    const enrichedMetrics = (enriched.metrics as Record<string, unknown>[]) ?? [];

    const existingById = new Map(
      existingMetrics.map((m) => [m.id as string, m])
    );

    for (const em of enrichedMetrics) {
      const id = em.id as string;
      if (existingById.has(id)) {
        // Merge new fields into existing metric (don't overwrite existing fields)
        const existing = existingById.get(id)!;
        for (const [key, val] of Object.entries(em)) {
          if (key === "id") continue;
          if (!(key in existing) && val !== null && val !== undefined) {
            (existing as Record<string, unknown>)[key] = val;
          }
        }
      } else {
        // Append new metric
        existingMetrics.push(em);
      }
    }

    const output = yaml.dump(
      { ...existingYaml, metrics: existingMetrics },
      { lineWidth: 120, noRefs: true }
    );
    fs.writeFileSync(filePath, output);
    console.log(`    Updated ${fileName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`    Error enriching ${fileName}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function enrichSemanticLayer(
  profiles: TableProfile[],
  options?: { semanticDir?: string }
): Promise<void> {
  const semanticDir = options?.semanticDir ?? SEMANTIC_DIR;
  const entitiesDir = path.join(semanticDir, "entities");
  const metricsDir = path.join(semanticDir, "metrics");

  const model = getModel();
  const usage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  // Build a lookup from table name -> profile
  const profileByTable = new Map(
    profiles.map((p) => [p.table_name, p])
  );

  // 1. Enrich entity YAMLs
  console.log("  --- Entity enrichment ---\n");

  if (fs.existsSync(entitiesDir)) {
    const entityFiles = fs
      .readdirSync(entitiesDir)
      .filter((f) => f.endsWith(".yml"));

    for (const file of entityFiles) {
      const tableName = file.replace(/\.yml$/, "");
      const profile = profileByTable.get(tableName);
      if (!profile) {
        console.log(`  Skipping ${file} (no matching profile)`);
        continue;
      }
      await enrichEntity(
        path.join(entitiesDir, file),
        profile,
        model,
        usage
      );
    }
  }

  // 2. Enrich glossary
  console.log("\n  --- Glossary enrichment ---\n");

  await enrichGlossary(profiles, model, usage, semanticDir);

  // 3. Enrich metrics
  console.log("\n  --- Metrics enrichment ---\n");

  if (fs.existsSync(metricsDir)) {
    const metricFiles = fs
      .readdirSync(metricsDir)
      .filter((f) => f.endsWith(".yml"));

    for (const file of metricFiles) {
      // Try to match metric file to a table profile
      const tableName = file.replace(/\.yml$/, "");
      const profile = profileByTable.get(tableName);

      if (!profile) {
        // Metric files might not map 1:1 to tables (e.g., revenue.yml, engagement.yml).
        // Use the first profile that has relevant columns as a fallback.
        const fallbackProfile = profiles[0];
        if (fallbackProfile) {
          await enrichMetric(
            path.join(metricsDir, file),
            fallbackProfile,
            model,
            usage
          );
        } else {
          console.log(`  Skipping ${file} (no profiles available)`);
        }
        continue;
      }
      await enrichMetric(
        path.join(metricsDir, file),
        profile,
        model,
        usage
      );
    }
  }

  // Print token usage summary
  console.log("\n  --- Token usage ---\n");
  console.log(`  Prompt tokens:     ${usage.promptTokens.toLocaleString()}`);
  console.log(`  Completion tokens: ${usage.completionTokens.toLocaleString()}`);
  console.log(`  Total tokens:      ${usage.totalTokens.toLocaleString()}`);
}
