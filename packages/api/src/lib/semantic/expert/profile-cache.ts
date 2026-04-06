/**
 * Profile cache for the semantic expert scheduler.
 *
 * Caches profiler output to `{semanticRoot}/.expert-cache/profiles.json`
 * so the scheduled expert tick can use real DB profiles rather than
 * running with an empty set.
 *
 * Cache is written by `atlas init` and `atlas improve` after profiling,
 * and read by the scheduled expert tick.
 */

import * as fs from "fs";
import * as path from "path";
import { createLogger } from "@atlas/api/lib/logger";
import type { TableProfile } from "@useatlas/types";

const log = createLogger("semantic-expert-profile-cache");

/** Cache staleness threshold — 7 days in milliseconds. */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache directory name under the semantic root. */
const CACHE_DIR = ".expert-cache";

/** Cache file name. */
const CACHE_FILE = "profiles.json";

/** Shape of the serialized cache file. */
interface ProfileCacheEnvelope {
  cachedAt: string;
  profiles: TableProfile[];
}

/**
 * Resolve the semantic root directory.
 * Mirrors the logic in context-loader.ts.
 */
function getSemanticRoot(): string {
  return process.env.ATLAS_SEMANTIC_ROOT ?? path.resolve(process.cwd(), "semantic");
}

/** Resolve the full path to the cache file. */
function getCachePath(): string {
  return path.join(getSemanticRoot(), CACHE_DIR, CACHE_FILE);
}

/**
 * Write profiler output to the cache file.
 *
 * Creates the `.expert-cache/` directory if it doesn't exist.
 */
export function cacheProfiles(profiles: TableProfile[]): void {
  const cachePath = getCachePath();
  const cacheDir = path.dirname(cachePath);

  try {
    fs.mkdirSync(cacheDir, { recursive: true });

    const envelope: ProfileCacheEnvelope = {
      cachedAt: new Date().toISOString(),
      profiles,
    };

    fs.writeFileSync(cachePath, JSON.stringify(envelope), "utf-8");
    log.debug({ count: profiles.length, path: cachePath }, "Cached profiler output");
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to write profile cache",
    );
  }
}

/**
 * Load cached profiler output.
 *
 * Returns an empty array if the cache file is missing or unreadable.
 * Logs a warning if the cache is older than 7 days.
 */
export function loadCachedProfiles(): TableProfile[] {
  const cachePath = getCachePath();

  try {
    if (!fs.existsSync(cachePath)) {
      log.debug("No profile cache found — scheduled expert will run without profiles");
      return [];
    }

    const raw = fs.readFileSync(cachePath, "utf-8");
    const envelope = JSON.parse(raw) as ProfileCacheEnvelope;

    if (!Array.isArray(envelope.profiles)) {
      log.warn("Profile cache has unexpected shape — ignoring");
      return [];
    }

    // Check staleness
    if (envelope.cachedAt) {
      const cachedAt = new Date(envelope.cachedAt).getTime();
      const age = Date.now() - cachedAt;
      if (age > STALE_THRESHOLD_MS) {
        const days = Math.round(age / (24 * 60 * 60 * 1000));
        log.warn(
          { cachedAt: envelope.cachedAt, ageDays: days },
          "Profile cache is stale — run 'atlas improve' to refresh",
        );
      }
    }

    log.debug({ count: envelope.profiles.length }, "Loaded cached profiles");
    return envelope.profiles;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to read profile cache",
    );
    return [];
  }
}

/**
 * Delete the cached profile file.
 */
export function invalidateProfileCache(): void {
  const cachePath = getCachePath();

  try {
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
      log.debug("Invalidated profile cache");
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to invalidate profile cache",
    );
  }
}
