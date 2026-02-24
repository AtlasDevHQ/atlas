/**
 * Semantic layer utilities.
 *
 * Reads the semantic/ directory to extract metadata used by the SQL tool
 * (table whitelist) and the CLI (schema profiling).
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

const SEMANTIC_ROOT = path.resolve(process.cwd(), "semantic");

interface Entity {
  name: string;
  table: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

let _whitelistedTables: Set<string> | null = null;

export function getWhitelistedTables(): Set<string> {
  if (_whitelistedTables) return _whitelistedTables;

  const tables = new Set<string>();
  const entitiesDir = path.join(SEMANTIC_ROOT, "entities");

  if (!fs.existsSync(entitiesDir)) return tables;

  const files = fs.readdirSync(entitiesDir).filter((f) => f.endsWith(".yml"));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(entitiesDir, file), "utf-8");
      const entity = yaml.load(content) as Entity;
      if (entity?.table) {
        // Extract table name (may include schema prefix like "public.users")
        const parts = entity.table.split(".");
        const tableName = parts[parts.length - 1].toLowerCase();
        tables.add(tableName);

        // Also add the full qualified name
        tables.add(entity.table.toLowerCase());
      }
    } catch {
      // Skip malformed files
    }
  }

  _whitelistedTables = tables;
  return tables;
}
