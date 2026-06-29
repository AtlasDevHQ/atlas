import { describe, it, expect } from "bun:test";

import {
  listWorkspaces,
  setActiveWorkspace,
  readWorkspaceOverride,
  resolveActiveWorkspace,
  WorkspaceError,
} from "../lib/workspaces";

const BASE = "http://localhost:3001";
const TOKEN = "sess_abc";

interface ResponseSpec {
  status: number;
  body: unknown;
}

/** A fetch stub that returns a single queued response and records the request. */
function stubFetch(spec: ResponseSpec): { fetchImpl: typeof fetch; calls: Request[] } {
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

const rejectingFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

describe("listWorkspaces (#4050)", () => {
  it("returns the user's workspaces from /organization/list", async () => {
    const { fetchImpl, calls } = stubFetch({
      status: 200,
      body: [
        { id: "org_1", name: "Acme", slug: "acme" },
        { id: "org_2", name: "Beta", slug: "beta" },
      ],
    });
    const out = await listWorkspaces(BASE, TOKEN, { fetchImpl });
    expect(out).toEqual([
      { id: "org_1", name: "Acme", slug: "acme" },
      { id: "org_2", name: "Beta", slug: "beta" },
    ]);
    expect(calls[0].url).toBe(`${BASE}/api/auth/organization/list`);
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("returns [] when the user has no workspaces", async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: [] });
    expect(await listWorkspaces(BASE, TOKEN, { fetchImpl })).toEqual([]);
  });

  it("falls back name→id and slug→null for sparse rows", async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: [{ id: "org_3" }] });
    expect(await listWorkspaces(BASE, TOKEN, { fetchImpl })).toEqual([
      { id: "org_3", name: "org_3", slug: null },
    ]);
  });

  it("drops malformed rows (missing id) rather than trusting the shape", async () => {
    const { fetchImpl } = stubFetch({
      status: 200,
      body: [{ name: "no id" }, { id: "org_4", name: "Good" }],
    });
    expect(await listWorkspaces(BASE, TOKEN, { fetchImpl })).toEqual([
      { id: "org_4", name: "Good", slug: null },
    ]);
  });

  it("throws unauthorized on 401", async () => {
    const { fetchImpl } = stubFetch({ status: 401, body: { error: "nope" } });
    await expect(listWorkspaces(BASE, TOKEN, { fetchImpl })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("throws request_failed on a 500", async () => {
    const { fetchImpl } = stubFetch({ status: 500, body: {} });
    await expect(listWorkspaces(BASE, TOKEN, { fetchImpl })).rejects.toMatchObject({
      code: "request_failed",
    });
  });

  it("throws network_error when the request rejects", async () => {
    await expect(
      listWorkspaces(BASE, TOKEN, { fetchImpl: rejectingFetch }),
    ).rejects.toMatchObject({ code: "network_error" });
  });

  it("degrades a non-JSON 2xx body to []", async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: undefined });
    expect(await listWorkspaces(BASE, TOKEN, { fetchImpl })).toEqual([]);
  });
});

describe("setActiveWorkspace (#4050)", () => {
  it("POSTs the organizationId and returns the activated workspace", async () => {
    const { fetchImpl, calls } = stubFetch({
      status: 200,
      body: { id: "org_2", name: "Beta", slug: "beta" },
    });
    const out = await setActiveWorkspace(BASE, TOKEN, "org_2", { fetchImpl });
    expect(out).toEqual({ id: "org_2", name: "Beta", slug: "beta" });
    expect(calls[0].url).toBe(`${BASE}/api/auth/organization/set-active`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    const sent = await calls[0].json();
    expect(sent).toEqual({ organizationId: "org_2" });
  });

  it("rejects a non-member target with not_a_member (403)", async () => {
    const { fetchImpl } = stubFetch({
      status: 403,
      body: { code: "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION" },
    });
    await expect(
      setActiveWorkspace(BASE, TOKEN, "org_x", { fetchImpl }),
    ).rejects.toMatchObject({ code: "not_a_member" });
  });

  it("maps 400/404 to not_found", async () => {
    const { fetchImpl } = stubFetch({ status: 400, body: { code: "ORGANIZATION_NOT_FOUND" } });
    await expect(
      setActiveWorkspace(BASE, TOKEN, "org_missing", { fetchImpl }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("throws unauthorized on 401", async () => {
    const { fetchImpl } = stubFetch({ status: 401, body: {} });
    await expect(
      setActiveWorkspace(BASE, TOKEN, "org_2", { fetchImpl }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("throws network_error when the request rejects", async () => {
    await expect(
      setActiveWorkspace(BASE, TOKEN, "org_2", { fetchImpl: rejectingFetch }),
    ).rejects.toMatchObject({ code: "network_error" });
  });

  it("falls back to a minimal summary when the 2xx body is empty", async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: undefined });
    expect(await setActiveWorkspace(BASE, TOKEN, "org_2", { fetchImpl })).toEqual({
      id: "org_2",
      name: "org_2",
      slug: null,
    });
  });

  it("exposes WorkspaceError as the thrown type", async () => {
    const { fetchImpl } = stubFetch({ status: 500, body: {} });
    await expect(
      setActiveWorkspace(BASE, TOKEN, "org_2", { fetchImpl }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });
});

describe("readWorkspaceOverride (#4050)", () => {
  it("reads --workspace <id> (space form)", () => {
    expect(readWorkspaceOverride(["entities", "--workspace", "org_9"])).toBe("org_9");
  });
  it("reads --workspace=<id> (inline form) — never silently dropped", () => {
    expect(readWorkspaceOverride(["entities", "--workspace=org_9"])).toBe("org_9");
  });
  it("returns undefined for an empty inline value (--workspace=)", () => {
    expect(readWorkspaceOverride(["entities", "--workspace="])).toBeUndefined();
  });
  it("falls through an empty inline to a valid space form", () => {
    expect(readWorkspaceOverride(["entities", "--workspace=", "--workspace", "org_5"])).toBe("org_5");
  });
  it("lets a later inline override win", () => {
    expect(readWorkspaceOverride(["entities", "--workspace=org_1", "--workspace=org_2"])).toBe("org_2");
  });
  it("returns undefined when the flag is absent", () => {
    expect(readWorkspaceOverride(["entities", "--json"])).toBeUndefined();
  });
  it("returns undefined when --workspace has no value (next token is a flag)", () => {
    expect(readWorkspaceOverride(["entities", "--workspace", "--json"])).toBeUndefined();
  });
  it("returns undefined when --workspace is the last token", () => {
    expect(readWorkspaceOverride(["entities", "--workspace"])).toBeUndefined();
  });
});

describe("resolveActiveWorkspace (#4050)", () => {
  it("returns the stored default when no --workspace override is present", async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: {} });
    const out = await resolveActiveWorkspace(["entities"], BASE, TOKEN, "org_default", { fetchImpl });
    expect(out).toBe("org_default");
    // No set-active call when there is no override.
    expect(calls.length).toBe(0);
  });

  it("returns null when there is no override and no stored default", async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: {} });
    expect(await resolveActiveWorkspace(["entities"], BASE, TOKEN, null, { fetchImpl })).toBeNull();
  });

  it("rebinds to the override via set-active and returns its id", async () => {
    const { fetchImpl, calls } = stubFetch({
      status: 200,
      body: { id: "org_9", name: "Nine", slug: "nine" },
    });
    const out = await resolveActiveWorkspace(
      ["entities", "--workspace", "org_9"],
      BASE,
      TOKEN,
      "org_default",
      { fetchImpl },
    );
    expect(out).toBe("org_9");
    expect(calls[0].url).toBe(`${BASE}/api/auth/organization/set-active`);
  });

  it("propagates not_a_member when the override targets a non-member workspace", async () => {
    const { fetchImpl } = stubFetch({ status: 403, body: {} });
    await expect(
      resolveActiveWorkspace(["entities", "--workspace", "org_x"], BASE, TOKEN, "org_default", { fetchImpl }),
    ).rejects.toMatchObject({ code: "not_a_member" });
  });
});
