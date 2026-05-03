/**
 * Bundled demo fixture path resolution.
 *
 * `init --local` falls back to a tiny accounts/companies/people SQLite
 * fixture when `ATLAS_DATASOURCE_URL` is unset, so a fresh user gets a
 * working install with zero config. The `serve` side hydrates the SQLite
 * file from `seed.sql` on first run; here we just resolve the canonical
 * paths and the URL string written into the client config.
 */

import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

interface ResolveOpts {
  cacheDir?: string;
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
  // import.meta.url here resolves to the .ts source in dev, .js bundle if
  // built. Either way, ../../fixtures/seed.sql is the right relative path
  // because seed.sql sits alongside src/ inside the package root.
  const here = fileURLToPath(import.meta.url);
  const seedPath = resolve(here, "..", "..", "..", "fixtures", "seed.sql");
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const sqlitePath = join(cacheDir, "demo.sqlite");
  const sqliteUrl = `sqlite://${sqlitePath}`;
  return { seedPath, sqlitePath, sqliteUrl };
}

export function shouldUseFixture(env: Record<string, string | undefined>): boolean {
  const url = env.ATLAS_DATASOURCE_URL;
  return url === undefined || url === "";
}
