/**
 * Profile cache for the semantic expert scheduler.
 *
 * Caches profiler output to `{semanticRoot}/.expert-cache/profiles.json`
 * so the scheduled expert tick can use real DB profiles rather than
 * running with an empty set.
 *
 * Cache is written after profiling (by `atlas init`, `atlas improve`,
 * or any CLI command that runs the profiler) and read by the scheduled
 * expert tick.
 */

import * as fs from "fs";
import * as path from "path";
import { createLogger } from "@atlas/api/lib/logger";
import { getSemanticRoot } from "@atlas/api/lib/semantic/files";
import type { TableProfile } from "@useatlas/types";

const log = createLogger("semantic-expert-profile-cache");

/** Profiles older than 7 days may reference columns/tables that have changed. */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

const CACHE_DIR = ".expert-cache";
const CACHE_FILE = "profiles.json";

/** Shape of the serialized cache file. */
interface ProfileCacheEnvelope {
  cachedAt: string;
  profiles: TableProfile[];
}

/** Resolve the full path to the cache file. */
function getCachePath(): string {
  return path.join(getSemanticRoot(), CACHE_DIR, CACHE_FILE);
}

/**
 * Write profiler output to the cache file.
 *
 * Creates the `.expert-cache/` directory if it doesn't exist.
 * Uses atomic write (tmp + rename) to avoid partial writes on crash.
 */
export function cacheProfiles(profiles: TableProfile[]): void {
  const cachePath = getCachePath();
  const cacheDir = path.dirname(cachePath);
  const tmpPath = cachePath + ".tmp";

  try {
    fs.mkdirSync(cacheDir, { recursive: true });

    const envelope: ProfileCacheEnvelope = {
      cachedAt: new Date().toISOString(),
      profiles,
    };

    fs.writeFileSync(tmpPath, JSON.stringify(envelope), "utf-8");
    fs.renameSync(tmpPath, cachePath);
    log.debug({ count: profiles.length, path: cachePath }, "Cached profiler output");
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)), path: cachePath },
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
      log.warn(
        { cachePath, profilesType: typeof envelope.profiles },
        "Profile cache has unexpected shape — ignoring",
      );
      return [];
    }

    // Check staleness
    if (envelope.cachedAt) {
      const cachedAt = new Date(envelope.cachedAt).getTime();
      if (!Number.isFinite(cachedAt)) {
        log.warn(
          { cachedAt: envelope.cachedAt },
          "Profile cache has invalid timestamp — treating as stale",
        );
      } else {
        const age = Date.now() - cachedAt;
        if (age > STALE_THRESHOLD_MS) {
          const days = Math.round(age / (24 * 60 * 60 * 1000));
          log.warn(
            { cachedAt: envelope.cachedAt, ageDays: days },
            "Profile cache is stale — run 'atlas improve' to refresh",
          );
        }
      }
    }

    log.debug({ count: envelope.profiles.length }, "Loaded cached profiles");
    return envelope.profiles;
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
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
      { err: err instanceof Error ? err : new Error(String(err)) },
      "Failed to invalidate profile cache",
    );
  }
}
