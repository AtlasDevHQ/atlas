/**
 * F-47 encryption keyset resolver.
 *
 * Parses `ATLAS_ENCRYPTION_KEYS` (multi-key, versioned) or the legacy
 * single-key env vars (`ATLAS_ENCRYPTION_KEY` → `BETTER_AUTH_SECRET`)
 * into an ordered keyset and exposes the lookup API consumed by the
 * cipher helpers (`encryptUrl`/`decryptUrl`, `encryptSecret`/`decryptSecret`)
 * and the re-encryption script (`scripts/rotate-encryption-key.ts`).
 *
 * See `apps/docs/content/docs/platform-ops/encryption-key-rotation.mdx`
 * for the operator-facing runbook.
 */
import * as crypto from "crypto";

/** A single 32-byte AES key paired with its stable version label. */
export interface VersionedKey {
  readonly version: number;
  readonly key: Buffer;
}

/**
 * Resolved keyset. The `active` entry is used for all writes; reads try
 * the active key first, then fall back to legacy keys via `byVersion`
 * lookup or a whole-keyset scan (`decrypt`) for un-versioned ciphertext.
 *
 * `source` identifies which env var populated the keyset — used by
 * startup warnings (`BETTER_AUTH_SECRET` fallback under SaaS is a P2
 * deprecation signal).
 */
export interface EncryptionKeyset {
  readonly active: VersionedKey;
  readonly byVersion: ReadonlyMap<number, Buffer>;
  /** All keys ordered [active, legacy1, legacy2, ...] — for full-scan fallbacks on un-versioned ciphertext. */
  readonly decrypt: readonly VersionedKey[];
  readonly source: "ATLAS_ENCRYPTION_KEYS" | "ATLAS_ENCRYPTION_KEY" | "BETTER_AUTH_SECRET";
}

interface CacheEntry {
  readonly source: EncryptionKeyset["source"];
  readonly raw: string;
  readonly keyset: EncryptionKeyset;
}

let _cache: CacheEntry | null = null;

/** SHA-256 a raw value to a fixed 32-byte AES key. */
function deriveKey(raw: string): Buffer {
  return crypto.createHash("sha256").update(raw).digest();
}

/**
 * Parse one entry from `ATLAS_ENCRYPTION_KEYS`. Returns `{ version, raw }`
 * when the entry is prefixed (`v2:raw`), or `{ raw }` when it isn't.
 * Throws on malformed prefixes so a typo doesn't silently degrade to a
 * positional fallback.
 */
function parseEntry(entry: string): { version: number | null; raw: string } {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return { version: null, raw: "" };

  // Match `v<anything>:...` first so a typo like `vlatest:` surfaces as
  // a hard error rather than silently degrading to a positional entry.
  const attempt = trimmed.match(/^v([^:]*):(.*)$/s);
  if (!attempt) {
    return { version: null, raw: trimmed };
  }
  const label = attempt[1];
  if (!/^\d+$/.test(label)) {
    throw new Error(
      `ATLAS_ENCRYPTION_KEYS: version label must be a positive integer, got "v${label}"`,
    );
  }
  const version = Number.parseInt(label, 10);
  if (!Number.isFinite(version) || version < 1) {
    throw new Error(
      `ATLAS_ENCRYPTION_KEYS: version label must be a positive integer, got "v${label}"`,
    );
  }
  const match = attempt;
  const raw = match[2];
  if (raw.length === 0) {
    throw new Error(
      `ATLAS_ENCRYPTION_KEYS: entry "v${version}:" has empty raw key material`,
    );
  }
  return { version, raw };
}

/** Internal: build an EncryptionKeyset from a source + ordered list of versioned entries. */
function buildKeyset(
  source: EncryptionKeyset["source"],
  entries: readonly { version: number; raw: string }[],
): EncryptionKeyset {
  const byVersion = new Map<number, Buffer>();
  const decrypt: VersionedKey[] = [];
  for (const { version, raw } of entries) {
    if (byVersion.has(version)) {
      throw new Error(
        `ATLAS_ENCRYPTION_KEYS: version v${version} appears more than once — each version must be unique (likely duplicate entry)`,
      );
    }
    const key = deriveKey(raw);
    byVersion.set(version, key);
    decrypt.push({ version, key });
  }
  const active = decrypt[0];
  return { active, byVersion, decrypt, source };
}

/**
 * Returns the resolved encryption keyset or `null` when no key env var
 * is set (dev / self-hosted passthrough). Result is cached — callers in
 * tests should `_resetEncryptionKeyCache()` after mutating env vars.
 *
 * Throws on malformed `ATLAS_ENCRYPTION_KEYS` input (duplicate versions,
 * mixed-prefix entries, non-numeric version labels, empty raw material).
 * A loud throw at startup is load-bearing: a silent fallback to a
 * partial keyset would let rotated ciphertext land un-readable without
 * any operator-visible signal.
 */
export function getEncryptionKeyset(): EncryptionKeyset | null {
  const keysRaw = process.env.ATLAS_ENCRYPTION_KEYS;
  const keyRaw = process.env.ATLAS_ENCRYPTION_KEY;
  const authRaw = process.env.BETTER_AUTH_SECRET;

  let source: EncryptionKeyset["source"];
  let rawForCache: string;
  let entries: { version: number; raw: string }[];

  if (keysRaw && keysRaw.length > 0) {
    source = "ATLAS_ENCRYPTION_KEYS";
    rawForCache = keysRaw;
    const parsed = keysRaw
      .split(",")
      .map(parseEntry)
      .filter((e) => e.raw.length > 0);
    if (parsed.length === 0) {
      throw new Error("ATLAS_ENCRYPTION_KEYS is set but has no non-empty entries");
    }
    const prefixed = parsed.filter((e) => e.version !== null);
    const bare = parsed.filter((e) => e.version === null);
    if (prefixed.length > 0 && bare.length > 0) {
      throw new Error(
        "ATLAS_ENCRYPTION_KEYS: entries mix prefixed (v<N>:raw) and bare raw values — " +
        "use one style throughout to keep version numbers unambiguous",
      );
    }
    if (prefixed.length === parsed.length) {
      entries = parsed.map((e) => ({ version: e.version as number, raw: e.raw }));
    } else {
      // All bare — assign versions positionally: first entry = count, last = 1.
      const total = parsed.length;
      entries = parsed.map((e, i) => ({ version: total - i, raw: e.raw }));
    }
  } else if (keyRaw && keyRaw.length > 0) {
    source = "ATLAS_ENCRYPTION_KEY";
    rawForCache = keyRaw;
    entries = [{ version: 1, raw: keyRaw }];
  } else if (authRaw && authRaw.length > 0) {
    source = "BETTER_AUTH_SECRET";
    rawForCache = authRaw;
    entries = [{ version: 1, raw: authRaw }];
  } else {
    _cache = null;
    return null;
  }

  if (_cache && _cache.source === source && _cache.raw === rawForCache) {
    return _cache.keyset;
  }

  const keyset = buildKeyset(source, entries);
  _cache = { source, raw: rawForCache, keyset };
  return keyset;
}

/**
 * Active 32-byte AES key buffer, or `null` when no key env var is set.
 * Back-compat shim — new code should prefer `getEncryptionKeyset()`.
 */
export function getEncryptionKey(): Buffer | null {
  return getEncryptionKeyset()?.active.key ?? null;
}

/**
 * Active keyset version — paired with the encrypt helpers so callers
 * can stamp the companion `<col>_key_version` schema column with the
 * same N that landed in the ciphertext's `enc:v<N>:` prefix.
 *
 * Lives next to the keyset resolver (not in `secret-encryption.ts`) so
 * callers who need just the version number don't force every existing
 * `mock.module("@atlas/api/lib/db/secret-encryption", ...)` partial-mock
 * site in the integration-store test files to add a new export stub.
 *
 * Returns 1 when no key is configured (dev passthrough); that matches
 * the DB-side `DEFAULT 1` on every `_key_version` column.
 */
export function activeKeyVersion(): number {
  return getEncryptionKeyset()?.active.version ?? 1;
}

/** @internal Reset cached keyset — for testing only. */
export function _resetEncryptionKeyCache(): void {
  _cache = null;
}
