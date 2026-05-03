/**
 * Resolves the bundled accounts/companies/people SQLite fixture used as the
 * fallback datasource when `ATLAS_DATASOURCE_URL` is unset.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

interface ResolveOpts {
  cacheDir?: string;
  /** Override the existsSync check (test seam). */
  existsSync?: (p: string) => boolean;
}

export interface FixturePaths {
  /** Absolute path to the bundled seed.sql shipped inside the package. */
  seedPath: string;
  /** Absolute path where the hydrated SQLite file will live on disk. */
  sqlitePath: string;
  /** Datasource URL string suitable for ATLAS_DATASOURCE_URL. */
  sqliteUrl: string;
}

function defaultCacheDir(): string {
  if (process.env.XDG_CACHE_HOME) {
    return join(process.env.XDG_CACHE_HOME, "atlas-mcp");
  }
  return join(homedir(), ".cache", "atlas-mcp");
}

export function resolveFixturePaths(opts: ResolveOpts = {}): FixturePaths {
  // resolves from src/init/fixture.{ts,js} → package root → fixtures/seed.sql
  const here = fileURLToPath(import.meta.url);
  const seedPath = resolve(here, "..", "..", "..", "fixtures", "seed.sql");
  const exists = opts.existsSync ?? existsSync;
  if (!exists(seedPath)) {
    // Fail loudly at init time — otherwise the user only finds out when
    // their MCP client tries to query an empty SQLite file later.
    throw new Error(
      `Bundled fixture seed.sql is missing at ${seedPath}. Reinstall @useatlas/mcp.`,
    );
  }
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const sqlitePath = join(cacheDir, "demo.sqlite");
  const sqliteUrl = `sqlite://${sqlitePath}`;
  return { seedPath, sqlitePath, sqliteUrl };
}

export function shouldUseFixture(env: Record<string, string | undefined>): boolean {
  const url = env.ATLAS_DATASOURCE_URL;
  return url === undefined || url === "";
}
