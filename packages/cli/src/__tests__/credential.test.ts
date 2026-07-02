/**
 * Shared CLI credential primitives (#4112) — unit tests.
 *
 * `lib/credential.ts` is the single source of the workspace-credential XOR and
 * its precedence/parse/header rules that `sql`/`metric`/`explore`/`datasource`
 * all reach through. The command suites exercise these indirectly; this pins the
 * three helpers directly so a regression surfaces here rather than as a confusing
 * cross-command failure.
 */

import { describe, it, expect } from "bun:test";

import {
  credentialHeaders,
  NOT_LOGGED_IN_MESSAGE,
  readApiKeyFlag,
  resolveCredential,
  resolveWorkspaceCredential,
  type CliCredential,
} from "../lib/credential";

describe("credentialHeaders", () => {
  it("sends a session token on Authorization: Bearer", () => {
    expect(credentialHeaders({ token: "sess_abc" })).toEqual({
      Authorization: "Bearer sess_abc",
      "X-Atlas-Mode": "developer",
    });
  });

  it("sends a workspace key on x-api-key (never Authorization)", () => {
    const headers = credentialHeaders({ apiKey: "atlas_wk_abc" });
    expect(headers).toEqual({ "x-api-key": "atlas_wk_abc", "X-Atlas-Mode": "developer" });
    expect(headers.Authorization).toBeUndefined();
  });

  // #4126 — the CLI always requests developer mode so an admin sees/queries
  // their own just-created drafts; the server downgrades non-admins back to
  // published, so this is safe to send unconditionally for either credential.
  it("always requests developer mode regardless of credential kind", () => {
    expect(credentialHeaders({ token: "sess_abc" })["X-Atlas-Mode"]).toBe("developer");
    expect(credentialHeaders({ apiKey: "atlas_wk_abc" })["X-Atlas-Mode"]).toBe("developer");
  });
});

describe("resolveCredential — precedence (#4112)", () => {
  const session = { token: "sess_abc" };

  it("prefers an api key over a stored session", () => {
    expect(resolveCredential("atlas_wk_abc", session)).toEqual({ apiKey: "atlas_wk_abc" });
  });

  it("falls back to the session when no api key is present", () => {
    expect(resolveCredential(undefined, session)).toEqual({ token: "sess_abc" });
  });

  it("returns null when neither is present (fail-closed)", () => {
    expect(resolveCredential(undefined, null)).toBeNull();
  });

  it("treats an empty-string api key as absent (no `apiKey: \"\"` credential)", () => {
    // An empty key is not a credential; it must fall through to the session, not
    // produce an `{ apiKey: "" }` — which `credentialHeaders` (a truthiness
    // branch) would otherwise route to a malformed `Authorization: Bearer undefined`.
    expect(resolveCredential("", session)).toEqual({ token: "sess_abc" });
  });
});

describe("readApiKeyFlag — both flag forms (#4112)", () => {
  it("reads the space form `--api-key <key>`", () => {
    expect(readApiKeyFlag(["sql", "SELECT 1", "--api-key", "k1"])).toBe("k1");
  });

  it("reads the inline form `--api-key=<key>`", () => {
    expect(readApiKeyFlag(["sql", "SELECT 1", "--api-key=k2"])).toBe("k2");
  });

  it("returns undefined when the flag is absent", () => {
    expect(readApiKeyFlag(["sql", "SELECT 1"])).toBeUndefined();
  });

  it("returns undefined for a dangling `--api-key` with no value", () => {
    expect(readApiKeyFlag(["sql", "SELECT 1", "--api-key"])).toBeUndefined();
  });

  it("does not consume a following flag as the key value", () => {
    expect(readApiKeyFlag(["sql", "SELECT 1", "--api-key", "--json"])).toBeUndefined();
  });
});

describe("resolveWorkspaceCredential — the shared login/exit shape (#4196)", () => {
  const session = { token: "sess_abc" };
  function capture(): { io: { err: (l: string) => void }; err: string[] } {
    const err: string[] = [];
    return { io: { err: (l) => err.push(l) }, err };
  }

  it("prefers the `--api-key` flag over both ATLAS_API_KEY and the session", () => {
    const { io, err } = capture();
    const cred = resolveWorkspaceCredential(
      ["metric", "run", "gmv", "--api-key", "flag_key"],
      { apiKey: "env_key", session },
      io,
    );
    expect(cred).toEqual({ apiKey: "flag_key" });
    expect(err).toHaveLength(0);
  });

  it("falls back to deps.apiKey (ATLAS_API_KEY) over the session", () => {
    const { io } = capture();
    expect(resolveWorkspaceCredential(["metric", "run", "gmv"], { apiKey: "env_key", session }, io)).toEqual({
      apiKey: "env_key",
    });
  });

  it("uses the stored session when no key is present", () => {
    const { io } = capture();
    expect(resolveWorkspaceCredential(["metric", "run", "gmv"], { session }, io)).toEqual({
      token: "sess_abc",
    });
  });

  it("returns null and emits the shared not-logged-in copy when neither is present", () => {
    const { io, err } = capture();
    const cred = resolveWorkspaceCredential(["metric", "run", "gmv"], { session: null }, io);
    expect(cred).toBeNull();
    // The copy names BOTH remedies (login + the unattended key) — what the
    // command suites assert via `.toContain("atlas login")` / `"ATLAS_API_KEY"`.
    expect(err).toEqual([NOT_LOGGED_IN_MESSAGE]);
    expect(NOT_LOGGED_IN_MESSAGE).toContain("atlas login");
    expect(NOT_LOGGED_IN_MESSAGE).toContain("ATLAS_API_KEY");
  });
});

describe("CliCredential — type-level XOR (compile-time)", () => {
  it("each branch is assignable to the union; the helpers narrow", () => {
    // A purely structural assertion: both single-field shapes are valid
    // CliCredentials, and the headers helper maps each to its one wire header.
    const tokenCred: CliCredential = { token: "t" };
    const keyCred: CliCredential = { apiKey: "k" };
    expect(credentialHeaders(tokenCred)).toHaveProperty("Authorization");
    expect(credentialHeaders(keyCred)).toHaveProperty("x-api-key");
  });
});
