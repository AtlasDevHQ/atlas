/**
 * `atlas explore` (#4049 / ADR-0025 missing endpoint #3) — CLI command tests.
 *
 * The command is a thin HTTP client over `POST /api/v1/explore`, authorized by
 * the `atlas login` workspace credential. The dispatch + rendering live in the
 * testable `runExplore` core (deps injected: the session, the API base URL, and
 * `fetch`), so request shaping, output, and error → message mapping are
 * unit-tested without a live server or `process.exit`.
 */

import { describe, it, expect } from "bun:test";

import { runExplore, type ExploreIO, type ExploreRunDeps } from "../commands/explore";
import type { StoredSession } from "../lib/credentials";

const BASE = "http://localhost:3001";
const SESSION: StoredSession = { token: "sess_abc", workspaceId: "org-1", createdAt: "2026-06-27T00:00:00Z" };

function capture(): { io: ExploreIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/** Single-canned-response fetch capturing requests + their init. */
function stubFetch(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === "string" ? url : url.toString(), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deps(
  fetchImpl: typeof fetch | undefined,
  session: StoredSession | null = SESSION,
): ExploreRunDeps {
  return { baseUrl: BASE, session, ...(fetchImpl !== undefined ? { fetchImpl } : {}) };
}

describe("runExplore — auth + usage guards", () => {
  it("--help prints usage and exits 0 without calling the API", async () => {
    const { fetchImpl, calls } = stubFetch(200, { output: "" });
    const { io, out } = capture();
    const code = await runExplore(["explore", "--help"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Usage: atlas explore");
    expect(calls).toHaveLength(0);
  });

  it("no command prints usage and exits 1", async () => {
    const { fetchImpl, calls } = stubFetch(200, { output: "" });
    const { io, out } = capture();
    const code = await runExplore(["explore"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("Usage: atlas explore");
    expect(calls).toHaveLength(0);
  });

  it("not logged in errors with a login hint and exits 1, without calling the API", async () => {
    const { fetchImpl, calls } = stubFetch(200, { output: "" });
    const { io, err } = capture();
    const code = await runExplore(["explore", "ls"], deps(fetchImpl, null), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("atlas login");
    expect(calls).toHaveLength(0);
  });
});

describe("runExplore — request shaping", () => {
  it("sends the positional command as { command } with a Bearer token", async () => {
    const { fetchImpl, calls } = stubFetch(200, { output: "ok" });
    const { io } = capture();
    const code = await runExplore(["explore", "cat catalog.yml"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/v1/explore`);
    expect(calls[0].init?.method).toBe("POST");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sess_abc");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ command: "cat catalog.yml" });
  });

  it("joins multiple positional args into one command, ignoring flags", async () => {
    const { fetchImpl, calls } = stubFetch(200, { output: "ok" });
    const { io } = capture();
    await runExplore(["explore", "grep", "-r", "revenue", "entities/", "--json"], deps(fetchImpl), io);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ command: "grep -r revenue entities/" });
  });

  it("preserves a ---style command argument (only the CLI's own flags are stripped)", async () => {
    // A future `grep --include='*.yml'` must reach the server intact — only
    // --json/--help/-h belong to the CLI, not to the command.
    const { fetchImpl, calls } = stubFetch(200, { output: "ok" });
    const { io } = capture();
    await runExplore(
      ["explore", "grep", "--include=*.yml", "-r", "revenue", "."],
      deps(fetchImpl),
      io,
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      command: "grep --include=*.yml -r revenue .",
    });
  });
});

describe("runExplore — output", () => {
  it("prints the command output on success (exit 0)", async () => {
    const { fetchImpl } = stubFetch(200, { output: "file1.yml\nfile2.yml" });
    const { io, out } = capture();
    const code = await runExplore(["explore", "ls"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("file1.yml");
    expect(out.join("\n")).toContain("file2.yml");
  });

  it("--json prints a JSON envelope", async () => {
    const { fetchImpl } = stubFetch(200, { output: "a\nb" });
    const { io, out } = capture();
    const code = await runExplore(["explore", "ls", "--json"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({ output: "a\nb" });
  });

  it("prints a command-level Error string verbatim and still exits 0 (a grep no-match is not a CLI failure)", async () => {
    // The server returns 200 with the facade's `Error (exit N):` string for a
    // non-zero-exit command — the CLI surfaces it as output, not an error.
    const { fetchImpl } = stubFetch(200, { output: "Error (exit 1):\n" });
    const { io, out } = capture();
    const code = await runExplore(["explore", "grep zzz ."], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Error (exit 1)");
  });

  it("prints (no output) when the 200 body has an empty/absent output field", async () => {
    const { fetchImpl } = stubFetch(200, {});
    const { io, out } = capture();
    const code = await runExplore(["explore", "ls"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("(no output)");
  });
});

describe("runExplore — network failure", () => {
  it("reports an unreachable API and exits 1 when fetch throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const { io, err } = capture();
    const code = await runExplore(["explore", "ls"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Failed to reach the Atlas API");
  });
});

describe("runExplore — HTTP error handling", () => {
  it("401 prompts re-login and exits 1", async () => {
    const { fetchImpl } = stubFetch(401, { error: "unauthorized" });
    const { io, err } = capture();
    const code = await runExplore(["explore", "ls"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n").toLowerCase()).toContain("atlas login");
  });

  it("403 ip_not_allowed surfaces the server message + requestId, not a hardcoded role copy (#4113)", async () => {
    // Explore is standardAuth with NO role gate — its only 403 is `ip_not_allowed`
    // from the IP allowlist. The command must surface the server's actionable
    // message + requestId, NOT the old hardcoded "current role" copy.
    const { fetchImpl } = stubFetch(403, {
      error: "ip_not_allowed",
      message: "Your IP address is not in the workspace's allowlist.",
      requestId: "req-ip-1",
    });
    const { io, err } = capture();
    const code = await runExplore(["explore", "ls"], deps(fetchImpl), io);
    expect(code).toBe(1);
    const joined = err.join("\n");
    expect(joined).toContain("not in the workspace's allowlist");
    expect(joined).toContain("(request req-ip-1)");
    expect(joined.toLowerCase()).not.toContain("current role");
  });

  it("non-ok HTTP status surfaces the server message + requestId and exits 1", async () => {
    const { fetchImpl } = stubFetch(500, {
      error: "internal_error",
      message: "An unexpected error occurred (ref: abc12345).",
      requestId: "abc12345-0000",
    });
    const { io, err } = capture();
    const code = await runExplore(["explore", "ls"], deps(fetchImpl), io);
    expect(code).toBe(1);
    const joined = err.join("\n");
    expect(joined).toContain("An unexpected error occurred");
    expect(joined).toContain("(request abc12345-0000)");
  });

  it("non-ok HTTP status with a non-JSON body falls back to the HTTP-status message", async () => {
    // A 5xx that isn't JSON degrades via asRecord(null) → {} to serverMessage's
    // `HTTP <status>` fallback rather than crashing on parse.
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: typeof url === "string" ? url : url.toString(), init });
      return new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const { io, err } = capture();
    const code = await runExplore(["explore", "ls"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("HTTP 502");
  });
});
