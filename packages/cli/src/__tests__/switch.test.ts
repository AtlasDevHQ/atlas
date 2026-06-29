import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { matchWorkspace, formatWorkspaceLabel, commitSwitch } from "../commands/switch";
import { saveSession, readSession } from "../lib/credentials";
import type { WorkspaceSummary } from "../lib/workspaces";

const WORKSPACES: WorkspaceSummary[] = [
  { id: "org_1", name: "Acme", slug: "acme" },
  { id: "org_2", name: "Beta Corp", slug: "beta" },
  { id: "org_3", name: "Gamma", slug: null },
];

describe("matchWorkspace (#4050)", () => {
  it("matches by id", () => {
    expect(matchWorkspace(WORKSPACES, "org_2")).toEqual(WORKSPACES[1]);
  });
  it("matches by slug", () => {
    expect(matchWorkspace(WORKSPACES, "acme")).toEqual(WORKSPACES[0]);
  });
  it("returns undefined for an unknown token", () => {
    expect(matchWorkspace(WORKSPACES, "nope")).toBeUndefined();
  });
  it("does not match a null slug against an empty/absent token", () => {
    // A slug-less workspace must only match by id, never by a falsy slug.
    expect(matchWorkspace(WORKSPACES, "")).toBeUndefined();
  });
});

describe("formatWorkspaceLabel (#4050)", () => {
  it("renders 'Name (slug)' when a slug exists", () => {
    expect(formatWorkspaceLabel(WORKSPACES[0])).toBe("Acme (acme)");
  });
  it("renders just the name when slug-less", () => {
    expect(formatWorkspaceLabel(WORKSPACES[2])).toBe("Gamma");
  });
});

function stubFetch(spec: { status: number; body: unknown }): {
  fetchImpl: typeof fetch;
  calls: Request[];
} {
  const calls: Request[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(typeof url === "string" ? url : url.toString(), init));
    return new Response(spec.body === undefined ? "" : JSON.stringify(spec.body), {
      status: spec.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("commitSwitch (#4050) — set-active → persist sequence (acceptance criterion 1)", () => {
  const base = "http://localhost:3001";
  let dir: string;
  const session = { token: "sess_abc", workspaceId: "org_1", createdAt: "2026-06-27T00:00:00.000Z" };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-switch-test-"));
    saveSession(base, session, dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists the SERVER-RETURNED id, not the requested token", async () => {
    // Server canonicalizes a slug-request to its id — we must persist the id.
    const { fetchImpl, calls } = stubFetch({
      status: 200,
      body: { id: "org_2", name: "Beta", slug: "beta" },
    });
    const result = await commitSwitch(base, session.token, "beta", { fetchImpl, configDir: dir });
    expect(result.active.id).toBe("org_2");
    expect(result.persisted).toBe(true);
    // The stored default is the server's id, and the bearer is untouched.
    const stored = readSession(base, dir);
    expect(stored?.workspaceId).toBe("org_2");
    expect(stored?.token).toBe("sess_abc");
    expect(calls[0].url).toBe(`${base}/api/auth/organization/set-active`);
  });

  it("propagates not_a_member for an unknown/removed workspace (criterion 2 for `switch <token>`)", async () => {
    const { fetchImpl } = stubFetch({ status: 403, body: {} });
    await expect(
      commitSwitch(base, session.token, "org_x", { fetchImpl, configDir: dir }),
    ).rejects.toMatchObject({ code: "not_a_member" });
    // A rejected switch must NOT rewrite the stored default.
    expect(readSession(base, dir)?.workspaceId).toBe("org_1");
  });

  it("reports persisted:false when the credential vanished mid-switch", async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: { id: "org_2", name: "Beta", slug: "beta" } });
    // Wipe the credential so updateSessionWorkspace finds no session to update.
    fs.rmSync(path.join(dir, "credentials"), { force: true });
    const result = await commitSwitch(base, session.token, "org_2", { fetchImpl, configDir: dir });
    expect(result.persisted).toBe(false);
  });
});
