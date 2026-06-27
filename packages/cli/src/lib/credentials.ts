/**
 * Atlas CLI credential store (#4043 / ADR-0025).
 *
 * `atlas login` (the OAuth 2.0 device-authorization flow) persists its session
 * bearer here so subsequent `atlas` commands — and in-session agents — inherit
 * the grant (ambient reuse), the `gh auth login` / `railway login` model.
 *
 * Layout: `~/.atlas/credentials`, a JSON file written `0600` inside a `0700`
 * `~/.atlas` directory. Entries are keyed by API base URL so logging in to
 * staging never clobbers a prod (or local) credential:
 *
 *   { "version": 1, "sessions": { "<baseUrl>": { token, workspaceId, createdAt } } }
 *
 * The stored token is a Better Auth SESSION bearer (ADR-0025): it carries no
 * separate refresh token and is sent as `Authorization: Bearer <token>`. It is
 * stamped `origin='cli'` server-side, so it resolves org-role-only for its
 * bound workspace. Deleting its server session (or this file) revokes it.
 *
 * Every function takes an optional `configDir` so tests point at a temp dir
 * without mutating `$HOME` or process env.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";

/** One stored device-flow session, keyed by API base URL. */
export interface StoredSession {
  /** The Better Auth session bearer token (sent as `Authorization: Bearer`). */
  readonly token: string;
  /** The workspace the credential is bound to, or null when unbound (multi-workspace login pending selection). */
  readonly workspaceId: string | null;
  /** ISO-8601 timestamp the credential was stored. */
  readonly createdAt: string;
}

interface CredentialStore {
  readonly version: 1;
  readonly sessions: Record<string, StoredSession>;
}

const CREDENTIALS_FILENAME = "credentials";
const DIR_NAME = ".atlas";
const EMPTY_STORE: CredentialStore = { version: 1, sessions: {} };

/** The default `~/.atlas` config directory. */
export function defaultConfigDir(): string {
  return join(homedir(), DIR_NAME);
}

/** Absolute path to the credentials file within `configDir`. */
export function credentialsPath(configDir: string = defaultConfigDir()): string {
  return join(configDir, CREDENTIALS_FILENAME);
}

/**
 * Normalize an API base URL into a stable store key — trailing slashes
 * stripped so `http://x:3001` and `http://x:3001/` map to one entry.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function readStore(configDir: string): CredentialStore {
  const path = credentialsPath(configDir);
  if (!existsSync(path)) return EMPTY_STORE;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read Atlas credentials at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const sessions =
      parsed && typeof parsed === "object" ? (parsed as { sessions?: unknown }).sessions : undefined;
    if (sessions && typeof sessions === "object") {
      // Validate each entry: a syntactically-valid file whose entry has a
      // non-string `token` (`{ "token": 123 }`) must NOT flow through typed as
      // a StoredSession — that would send `Authorization: Bearer undefined`.
      // Drop malformed entries rather than trust the shape.
      return { version: 1, sessions: coerceSessions(sessions as Record<string, unknown>) };
    }
    // A structurally-unexpected file is treated as empty rather than crashing
    // every command — re-login overwrites it. We do NOT silently swallow a
    // genuine read error above (that re-throws); this branch is only for a
    // syntactically-valid-but-wrong-shape file. Warn so a real corruption
    // isn't invisibly clobbered by the next `saveSession`.
    console.warn(
      `Atlas credentials at ${path} had an unexpected shape — treating as logged-out; \`atlas login\` will overwrite it.`,
    );
    return EMPTY_STORE;
  } catch (err) {
    throw new Error(
      `Atlas credentials at ${path} are corrupt (invalid JSON): ${err instanceof Error ? err.message : String(err)}. Re-run \`atlas login\` to overwrite.`,
      { cause: err },
    );
  }
}

/** Keep only entries that satisfy the {@link StoredSession} invariant. */
function coerceSessions(raw: Record<string, unknown>): Record<string, StoredSession> {
  const out: Record<string, StoredSession> = {};
  for (const [key, value] of Object.entries(raw)) {
    const v = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    if (!v || typeof v.token !== "string" || v.token.length === 0) {
      // Parity with the wrong-shape-file warning: a single corrupted entry is
      // dropped, but say so rather than silently presenting it as logged-out.
      console.warn(`Atlas credentials entry for ${key} was malformed and ignored — re-run \`atlas login\`.`);
      continue;
    }
    out[key] = {
      token: v.token,
      workspaceId: typeof v.workspaceId === "string" ? v.workspaceId : null,
      createdAt: typeof v.createdAt === "string" ? v.createdAt : "",
    };
  }
  return out;
}

function writeStore(configDir: string, store: CredentialStore): void {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  const path = credentialsPath(configDir);
  // mode 0600 on create; an existing file's mode is not lowered by writeFileSync,
  // so re-assert it would require chmod — acceptable: we created it 0600.
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/** Read the stored bearer for a base URL, or null when not logged in. */
export function readSession(
  baseUrl: string,
  configDir: string = defaultConfigDir(),
): StoredSession | null {
  const store = readStore(configDir);
  return store.sessions[normalizeBaseUrl(baseUrl)] ?? null;
}

/** Persist (or replace) the bearer for a base URL. */
export function saveSession(
  baseUrl: string,
  session: { token: string; workspaceId: string | null; createdAt: string },
  configDir: string = defaultConfigDir(),
): void {
  const store = readStore(configDir);
  const next: CredentialStore = {
    version: 1,
    sessions: { ...store.sessions, [normalizeBaseUrl(baseUrl)]: session },
  };
  writeStore(configDir, next);
}

/**
 * Remove the stored bearer for a base URL. Returns true when an entry was
 * removed. When the store becomes empty the file is deleted entirely.
 */
export function clearSession(
  baseUrl: string,
  configDir: string = defaultConfigDir(),
): boolean {
  const store = readStore(configDir);
  const key = normalizeBaseUrl(baseUrl);
  if (!(key in store.sessions)) return false;
  const remaining = { ...store.sessions };
  delete remaining[key];
  if (Object.keys(remaining).length === 0) {
    const path = credentialsPath(configDir);
    if (existsSync(path)) rmSync(path);
    return true;
  }
  writeStore(configDir, { version: 1, sessions: remaining });
  return true;
}
