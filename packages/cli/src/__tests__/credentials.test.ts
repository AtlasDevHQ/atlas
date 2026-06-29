import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  readSession,
  saveSession,
  clearSession,
  updateSessionWorkspace,
  credentialsPath,
  normalizeBaseUrl,
} from "../lib/credentials";

describe("CLI credential store (#4043 / ADR-0026)", () => {
  let dir: string;
  const base = "http://localhost:3001";
  const session = { token: "sess_abc", workspaceId: "org_1", createdAt: "2026-06-27T00:00:00.000Z" };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cred-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no credential is stored", () => {
    expect(readSession(base, dir)).toBeNull();
  });

  it("round-trips a saved session", () => {
    saveSession(base, session, dir);
    expect(readSession(base, dir)).toEqual(session);
  });

  it("writes the credentials file with 0600 permissions", () => {
    saveSession(base, session, dir);
    const mode = fs.statSync(credentialsPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keys entries by normalized base URL — trailing slashes do not create a second entry", () => {
    saveSession("http://localhost:3001/", session, dir);
    expect(readSession("http://localhost:3001", dir)).toEqual(session);
    expect(normalizeBaseUrl("http://x:3001///")).toBe("http://x:3001");
  });

  it("isolates credentials per environment (staging login does not clobber prod)", () => {
    const prod = { token: "prod_tok", workspaceId: "org_prod", createdAt: "2026-06-27T00:00:00.000Z" };
    const staging = { token: "stag_tok", workspaceId: "org_stag", createdAt: "2026-06-27T00:00:00.000Z" };
    saveSession("https://api.useatlas.dev", prod, dir);
    saveSession("https://api-staging.useatlas.dev", staging, dir);
    expect(readSession("https://api.useatlas.dev", dir)?.token).toBe("prod_tok");
    expect(readSession("https://api-staging.useatlas.dev", dir)?.token).toBe("stag_tok");
  });

  it("clearSession removes one entry and deletes the file when the store is empty", () => {
    saveSession(base, session, dir);
    expect(clearSession(base, dir)).toBe(true);
    expect(readSession(base, dir)).toBeNull();
    expect(fs.existsSync(credentialsPath(dir))).toBe(false);
  });

  it("clearSession keeps other entries when more than one exists", () => {
    saveSession("https://api.useatlas.dev", session, dir);
    saveSession("https://api-staging.useatlas.dev", session, dir);
    clearSession("https://api.useatlas.dev", dir);
    expect(readSession("https://api.useatlas.dev", dir)).toBeNull();
    expect(readSession("https://api-staging.useatlas.dev", dir)).not.toBeNull();
  });

  it("clearSession returns false when nothing was stored", () => {
    expect(clearSession(base, dir)).toBe(false);
  });

  it("throws a clear error on a corrupt (non-JSON) credentials file", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(credentialsPath(dir), "{not json");
    expect(() => readSession(base, dir)).toThrow(/corrupt/i);
  });

  it("drops a malformed entry (non-string token) rather than yielding `Bearer undefined`", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      credentialsPath(dir),
      JSON.stringify({ version: 1, sessions: { [base]: { token: 123, workspaceId: "org_1" } } }),
    );
    // The entry is invalid (token not a string), so it is not returned.
    expect(readSession(base, dir)).toBeNull();
  });

  it("treats a valid-JSON-but-wrong-shape file as logged-out (no `sessions` key)", () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(credentialsPath(dir), JSON.stringify({ unexpected: true }));
    expect(readSession(base, dir)).toBeNull();
  });

  describe("updateSessionWorkspace (#4050)", () => {
    it("rebinds the default workspace without touching the bearer", () => {
      saveSession(base, session, dir);
      expect(updateSessionWorkspace(base, "org_2", dir)).toBe(true);
      const after = readSession(base, dir);
      expect(after?.workspaceId).toBe("org_2");
      expect(after?.token).toBe("sess_abc");
      expect(after?.createdAt).toBe(session.createdAt);
    });

    it("can clear the default workspace (null)", () => {
      saveSession(base, session, dir);
      updateSessionWorkspace(base, null, dir);
      expect(readSession(base, dir)?.workspaceId).toBeNull();
    });

    it("returns false when no session exists (never mints a tokenless entry)", () => {
      expect(updateSessionWorkspace(base, "org_2", dir)).toBe(false);
      expect(readSession(base, dir)).toBeNull();
    });

    it("only rebinds the targeted base URL", () => {
      saveSession("https://api.useatlas.dev", { ...session, token: "prod_tok" }, dir);
      saveSession("https://api-staging.useatlas.dev", { ...session, token: "stag_tok" }, dir);
      updateSessionWorkspace("https://api.useatlas.dev", "org_prod_2", dir);
      expect(readSession("https://api.useatlas.dev", dir)?.workspaceId).toBe("org_prod_2");
      expect(readSession("https://api-staging.useatlas.dev", dir)?.workspaceId).toBe("org_1");
    });
  });
});
