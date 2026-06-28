import { describe, it, expect } from "bun:test";

import { runDatasource, type DatasourceIO, type DatasourceRunDeps } from "../commands/datasource";
import type { StoredSession } from "../lib/credentials";

const BASE = "http://localhost:3001";
const SESSION: StoredSession = { token: "sess_abc", workspaceId: "org-1", createdAt: "2026-06-27T00:00:00Z" };

function capture(): { io: DatasourceIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/** Single-canned-response fetch capturing requests. */
function stubFetch(status: number, body: unknown): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${typeof url === "string" ? url : url.toString()}`);
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
): DatasourceRunDeps {
  return { baseUrl: BASE, session, ...(fetchImpl !== undefined ? { fetchImpl } : {}) };
}

describe("runDatasource — auth + dispatch guards (#4044)", () => {
  it("with no session, refuses with a login hint and exit 1", async () => {
    const { io, err } = capture();
    const code = await runDatasource(["datasource", "list"], deps(undefined, null), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("atlas login");
  });

  it("no subcommand prints usage and exits 1", async () => {
    const { io, out } = capture();
    const code = await runDatasource(["datasource"], deps(undefined), io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("Usage: atlas datasource");
  });

  it("--help prints usage and exits 0", async () => {
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "--help"], deps(undefined), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Usage: atlas datasource");
  });

  it("unknown subcommand errors and exits 1", async () => {
    const { io, err } = capture();
    const code = await runDatasource(["datasource", "frobnicate"], deps(undefined), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Unknown datasource command");
  });

  it("an id-taking subcommand without an id errors", async () => {
    const { io, err } = capture();
    const code = await runDatasource(["datasource", "archive"], deps(undefined), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("atlas datasource archive <id>");
  });
});

describe("runDatasource — list (#4044)", () => {
  it("renders a table of the workspace's datasources", async () => {
    const { fetchImpl } = stubFetch(200, {
      connections: [
        { id: "prod-us", dbType: "postgres", status: "published", groupId: "prod", health: { status: "healthy" } },
      ],
    });
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "list"], deps(fetchImpl), io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("prod-us");
    expect(text).toContain("postgres");
    expect(text).toContain("healthy");
  });

  it("prints an empty-state line when there are no datasources", async () => {
    const { fetchImpl } = stubFetch(200, { connections: [] });
    const { io, out } = capture();
    await runDatasource(["datasource", "list"], deps(fetchImpl), io);
    expect(out.join("\n")).toContain("no datasources");
  });

  it("--json emits the workspace id + datasources", async () => {
    const { fetchImpl } = stubFetch(200, { connections: [{ id: "prod-us" }] });
    const { io, out } = capture();
    await runDatasource(["datasource", "list", "--json"], deps(fetchImpl), io);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.workspaceId).toBe("org-1");
    expect(parsed.datasources[0].id).toBe("prod-us");
  });
});

describe("runDatasource — get/test (#4044)", () => {
  it("get renders a detail block", async () => {
    const { fetchImpl } = stubFetch(200, {
      id: "prod-us",
      dbType: "postgres",
      status: "published",
      maskedUrl: "postgres://***@host/db",
    });
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "get", "prod-us"], deps(fetchImpl), io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Datasource: prod-us");
    expect(text).toContain("postgres://***@host/db");
  });

  it("test exits 0 on healthy", async () => {
    const { fetchImpl } = stubFetch(200, { status: "healthy", latencyMs: 12 });
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "test", "prod-us"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("healthy");
  });

  it("test exits 1 on a non-healthy result so scripts can branch", async () => {
    const { fetchImpl } = stubFetch(200, { status: "degraded", latencyMs: 0, message: "timeout" });
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "test", "prod-us"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("degraded");
  });

  it("get --json emits the raw detail, not the rendered block", async () => {
    const { fetchImpl } = stubFetch(200, { id: "prod-us", dbType: "postgres" });
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "get", "prod-us", "--json"], deps(fetchImpl), io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toEqual({ id: "prod-us", dbType: "postgres" });
  });

  it("test --json emits the raw result and still reflects health in the exit code", async () => {
    const { fetchImpl } = stubFetch(200, { status: "degraded", latencyMs: 0 });
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "test", "prod-us", "--json"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(JSON.parse(out.join("\n")).status).toBe("degraded");
  });
});

describe("runDatasource — mutations (#4044)", () => {
  it("archive confirms success and hints at restore", async () => {
    const { fetchImpl, calls } = stubFetch(200, { archived: { connection: true } });
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "archive", "old"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(calls[0]).toContain("POST http://localhost:3001/api/v1/admin/archive-connection");
    expect(out.join("\n")).toContain("restore old");
  });

  it("restore confirms the datasource is published/queryable again", async () => {
    const { fetchImpl } = stubFetch(200, { restored: { connection: true } });
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "restore", "old"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("queryable again");
  });

  it("delete confirms success", async () => {
    const { fetchImpl } = stubFetch(200, { success: true });
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "delete", "old"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain('Deleted datasource "old"');
  });

  it("a non-admin member is denied a mutating op with an actionable message", async () => {
    const { fetchImpl } = stubFetch(403, { error: "forbidden_role", message: "Admin role required." });
    const { io, err } = capture();
    const code = await runDatasource(["datasource", "delete", "prod-us"], deps(fetchImpl), io);
    expect(code).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("admin role");
    expect(text).toContain("atlas login");
  });
});

describe("runDatasource — unexpected errors are surfaced, not swallowed (#4044)", () => {
  it("an unexpected (non-DatasourceCliError) throw becomes an `Unexpected error` line + exit 1", async () => {
    const { fetchImpl } = stubFetch(200, { connections: [{ id: "x" }] });
    const errs: string[] = [];
    let firstOut = true;
    const io: DatasourceIO = {
      out: () => {
        // Simulate an unexpected downstream failure during rendering.
        if (firstOut) {
          firstOut = false;
          throw new Error("render boom");
        }
      },
      err: (l) => errs.push(l),
    };
    const code = await runDatasource(["datasource", "list"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("Unexpected error");
    expect(errs.join("\n")).toContain("render boom");
  });
});
