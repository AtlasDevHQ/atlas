/**
 * The shared workspace-command shell (#4196) — unit tests.
 *
 * `runWorkspaceCommand` is the ONE place the REST-backed subcommands gather
 * their credential inputs (base URL, stored session, `ATLAS_API_KEY`) and apply
 * the process exit code — boilerplate that used to live verbatim in five
 * `handleX` shells. This pins that gather-deps + exit-code contract ONCE so it
 * isn't re-tested per command.
 *
 * `../lib/api-base` and `../lib/credentials` are mocked (Bun requires
 * mock.module() to precede the import) so the shell is exercised without reading
 * `ATLAS_API_URL`/disk; `process.exit` is spied so a non-zero exit is observed
 * rather than killing the runner.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

import type { StoredSession } from "../lib/credentials";

const SESSION: StoredSession = {
  token: "sess_shell",
  workspaceId: "org-shell",
  createdAt: "2026-07-02T00:00:00Z",
};

let baseUrlToReturn = "http://api.shell.test";
let sessionToReturn: StoredSession | null = null;
/** Captures the base URL `runWorkspaceCommand` passes to `readSession`. */
let readSessionArg: string | undefined;

// Mock the two IO-touching helpers BEFORE importing the shell under test.
void mock.module("../lib/api-base", () => ({
  resolveApiBaseUrl: () => baseUrlToReturn,
}));
void mock.module("../lib/credentials", () => ({
  defaultConfigDir: () => "/tmp/atlas-test",
  credentialsPath: () => "/tmp/atlas-test/credentials.json",
  normalizeBaseUrl: (u: string) => u,
  readSession: (baseUrl: string) => {
    readSessionArg = baseUrl;
    return sessionToReturn;
  },
  saveSession: () => {},
  updateSessionWorkspace: () => {},
  clearSession: () => {},
}));

import { runWorkspaceCommand, type WorkspaceCommandDeps } from "../lib/workspace-command";

describe("runWorkspaceCommand", () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let origApiKey: string | undefined;

  beforeEach(() => {
    baseUrlToReturn = "http://api.shell.test";
    sessionToReturn = null;
    readSessionArg = undefined;
    origApiKey = process.env.ATLAS_API_KEY;
    delete process.env.ATLAS_API_KEY;
    // Record the exit code without terminating the runner.
    exitSpy = spyOn(process, "exit").mockImplementation(((_code?: number) => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    if (origApiKey === undefined) delete process.env.ATLAS_API_KEY;
    else process.env.ATLAS_API_KEY = origApiKey;
  });

  it("threads the resolved base URL and stored session into the core deps", async () => {
    sessionToReturn = SESSION;
    let seen: WorkspaceCommandDeps | undefined;
    await runWorkspaceCommand(["sql", "SELECT 1"], async (_args, deps) => {
      seen = deps;
      return 0;
    });
    expect(seen?.baseUrl).toBe("http://api.shell.test");
    expect(seen?.session).toEqual(SESSION);
    expect(seen?.apiKey).toBeUndefined();
    // The session is read for the SAME base URL the deps carry — a wrong-URL
    // read would load another workspace's session (or none) under a custom
    // ATLAS_API_URL. tsgo catches a dropped arg; this pins the value.
    expect(readSessionArg).toBe("http://api.shell.test");
  });

  it("forwards argv unchanged to the core", async () => {
    let seenArgs: string[] | undefined;
    await runWorkspaceCommand(["metric", "run", "gmv", "--json"], async (args) => {
      seenArgs = args;
      return 0;
    });
    expect(seenArgs).toEqual(["metric", "run", "gmv", "--json"]);
  });

  it("picks up ATLAS_API_KEY (trimmed) as the unattended-CI credential", async () => {
    process.env.ATLAS_API_KEY = "  atlas_wk_env  ";
    let seen: WorkspaceCommandDeps | undefined;
    await runWorkspaceCommand(["sql", "SELECT 1"], async (_a, deps) => {
      seen = deps;
      return 0;
    });
    expect(seen?.apiKey).toBe("atlas_wk_env");
  });

  it("omits apiKey when ATLAS_API_KEY is empty/whitespace (no `apiKey: \"\"`)", async () => {
    process.env.ATLAS_API_KEY = "   ";
    let seen: WorkspaceCommandDeps | undefined;
    await runWorkspaceCommand(["sql", "SELECT 1"], async (_a, deps) => {
      seen = deps;
      return 0;
    });
    expect(seen?.apiKey).toBeUndefined();
    expect("apiKey" in (seen ?? {})).toBe(false);
  });

  it("does NOT exit on a zero exit code (the process ends naturally)", async () => {
    await runWorkspaceCommand(["sql", "SELECT 1"], async () => 0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits with the core's non-zero code", async () => {
    await runWorkspaceCommand(["sql", "SELECT 1"], async () => 1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("passes the exact exit code through (not a hardcoded 1)", async () => {
    // A distinct code proves the shell threads the core's return value rather
    // than exiting 1 on any failure.
    await runWorkspaceCommand(["sql", "SELECT 1"], async () => 2);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
