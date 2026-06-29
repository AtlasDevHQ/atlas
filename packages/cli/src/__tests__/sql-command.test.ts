/**
 * `atlas sql` command-core tests (#4047 / ADR-0027).
 *
 * Exercises the testable `runSqlCommand` core with an injected session, base
 * URL, and stub `fetch` — no live server. Pins:
 *  - guards (no session, no SQL, --help, mutually-exclusive --json/--csv);
 *  - the request shape (POST to /api/v1/execute-sql, body carries ONLY
 *    sql [+ connectionId], never an org/workspace field — ADR-0027 §5);
 *  - output rendering (table / --json / --csv);
 *  - the typed-error → message mapping for every documented failure status.
 */

import { describe, it, expect } from "bun:test";

import { runSqlCommand, type SqlIO, type SqlRunDeps } from "../commands/sql";
import type { StoredSession } from "../lib/credentials";

const BASE = "http://localhost:3001";
const SESSION: StoredSession = {
  token: "sess_abc",
  workspaceId: "org-1",
  createdAt: "2026-06-27T00:00:00Z",
};

function capture(): { io: SqlIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/** Single-canned-response fetch capturing requests + their bodies. */
function stubFetch(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; calls: Array<{ method: string; url: string; body: string }> } {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: typeof url === "string" ? url : url.toString(),
      body: typeof init?.body === "string" ? init.body : "",
    });
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
): SqlRunDeps {
  return { baseUrl: BASE, session, ...(fetchImpl !== undefined ? { fetchImpl } : {}) };
}

const OK_ROWS = {
  columns: ["id", "name"],
  rows: [
    { id: 1, name: "alice" },
    { id: 2, name: "bob" },
  ],
  rowCount: 2,
  truncated: false,
  executionMs: 12,
  executedAt: "2026-06-29T00:00:00Z",
};

describe("runSqlCommand — guards", () => {
  it("with no session, refuses with a login hint and exits 1", async () => {
    const { io, err } = capture();
    const code = await runSqlCommand(["sql", "SELECT 1"], deps(undefined, null), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("atlas login");
  });

  it("--help prints usage and exits 0", async () => {
    const { io, out } = capture();
    const code = await runSqlCommand(["sql", "--help"], deps(undefined), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain('Usage: atlas sql "SELECT ..."');
  });

  it("no SQL positional errors and exits 1", async () => {
    const { io, err } = capture();
    const code = await runSqlCommand(["sql"], deps(undefined), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain('atlas sql "SELECT ..."');
  });

  it("--json and --csv together are rejected", async () => {
    const { io, err } = capture();
    const code = await runSqlCommand(["sql", "SELECT 1", "--json", "--csv"], deps(undefined), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("mutually exclusive");
  });
});

describe("runSqlCommand — request shape (ADR-0027 §5 isolation)", () => {
  it("POSTs to the execute-sql route with ONLY the sql in the body", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_ROWS);
    const { io } = capture();
    const code = await runSqlCommand(["sql", "SELECT id, name FROM users"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/api/v1/execute-sql`);
    // No org/workspace/owner field — workspace isolation derives from the bearer.
    expect(JSON.parse(calls[0].body)).toEqual({ sql: "SELECT id, name FROM users" });
  });

  it("threads --connection into the request body (and not the SQL positional)", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_ROWS);
    const { io } = capture();
    const code = await runSqlCommand(
      ["sql", "SELECT 1", "--connection", "warehouse"],
      deps(fetchImpl),
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(calls[0].body)).toEqual({ sql: "SELECT 1", connectionId: "warehouse" });
  });

  it("does not mistake the --connection value for the SQL positional", async () => {
    // `--connection warehouse` precedes the SQL; the value token must be skipped.
    const { fetchImpl, calls } = stubFetch(200, OK_ROWS);
    const { io } = capture();
    const code = await runSqlCommand(
      ["sql", "--connection", "warehouse", "SELECT 2"],
      deps(fetchImpl),
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(calls[0].body)).toEqual({ sql: "SELECT 2", connectionId: "warehouse" });
  });

  it("sends the Authorization bearer", async () => {
    const calls: Array<{ auth: string | null }> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ auth: headers.get("Authorization") });
      return new Response(JSON.stringify(OK_ROWS), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const { io } = capture();
    await runSqlCommand(["sql", "SELECT 1"], deps(fetchImpl), io);
    expect(calls[0].auth).toBe("Bearer sess_abc");
  });
});

describe("runSqlCommand — output", () => {
  it("renders a table by default", async () => {
    const { fetchImpl } = stubFetch(200, OK_ROWS);
    const { io, out } = capture();
    const code = await runSqlCommand(["sql", "SELECT id, name FROM users"], deps(fetchImpl), io);
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("id");
    expect(joined).toContain("alice");
  });

  it("emits raw JSON with --json", async () => {
    const { fetchImpl } = stubFetch(200, OK_ROWS);
    const { io, out } = capture();
    const code = await runSqlCommand(["sql", "SELECT 1", "--json"], deps(fetchImpl), io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.columns).toEqual(["id", "name"]);
    expect(parsed.rowCount).toBe(2);
  });

  it("emits CSV with --csv (headers + rows)", async () => {
    const { fetchImpl } = stubFetch(200, OK_ROWS);
    const { io, out } = capture();
    const code = await runSqlCommand(["sql", "SELECT 1", "--csv"], deps(fetchImpl), io);
    expect(code).toBe(0);
    const lines = out.join("\n").split("\n");
    expect(lines[0]).toBe("id,name");
    expect(lines[1]).toBe("1,alice");
    expect(lines[2]).toBe("2,bob");
  });

  it("notes an empty result", async () => {
    const { fetchImpl } = stubFetch(200, {
      columns: ["n"],
      rows: [],
      rowCount: 0,
      truncated: false,
      executionMs: 1,
      executedAt: "2026-06-29T00:00:00Z",
    });
    const { io, out } = capture();
    const code = await runSqlCommand(["sql", "SELECT 1 WHERE false"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("(no rows)");
  });

  it("flags a truncated result in table output", async () => {
    const { fetchImpl } = stubFetch(200, { ...OK_ROWS, truncated: true });
    const { io, out } = capture();
    const code = await runSqlCommand(["sql", "SELECT * FROM big"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("truncated");
  });
});

describe("runSqlCommand — error mapping", () => {
  it("maps 401 to a re-login hint", async () => {
    const { fetchImpl } = stubFetch(401, { error: "auth_error", message: "expired" });
    const { io, err } = capture();
    const code = await runSqlCommand(["sql", "SELECT 1"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("atlas login");
  });

  it("surfaces a 400 invalid_sql with the server message", async () => {
    const { fetchImpl } = stubFetch(400, {
      error: "invalid_sql",
      message: 'Table "secrets" is not in the allowed list.',
      requestId: "req-7",
    });
    const { io, err } = capture();
    const code = await runSqlCommand(["sql", "SELECT * FROM secrets"], deps(fetchImpl), io);
    expect(code).toBe(1);
    const joined = err.join("\n");
    expect(joined).toContain("allowed list");
    expect(joined).toContain("(request req-7)");
  });

  it("maps a 400 bad_request to the no-workspace guidance", async () => {
    const { fetchImpl } = stubFetch(400, {
      error: "bad_request",
      message: "Your login is not bound to a workspace.",
    });
    const { io, err } = capture();
    const code = await runSqlCommand(["sql", "SELECT 1"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not bound to a workspace");
  });

  it("surfaces a 403 billing/RLS block message verbatim", async () => {
    const { fetchImpl } = stubFetch(403, {
      error: "rls_blocked",
      message: "Row-level security blocked this query.",
      requestId: "req-1",
    });
    const { io, err } = capture();
    const code = await runSqlCommand(["sql", "SELECT * FROM orders"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Row-level security blocked");
  });

  it("surfaces a 409 approval-required message", async () => {
    const { fetchImpl } = stubFetch(409, {
      error: "approval_required",
      message: "This query requires approval before execution.",
    });
    const { io, err } = capture();
    const code = await runSqlCommand(["sql", "SELECT ssn FROM users"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("requires approval");
  });

  it("surfaces a 429 rate-limit message", async () => {
    const { fetchImpl } = stubFetch(429, { error: "rate_limited", message: "Slow down." });
    const { io, err } = capture();
    const code = await runSqlCommand(["sql", "SELECT 1"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Slow down.");
  });

  it("maps a 503 to the unavailable message", async () => {
    const { fetchImpl } = stubFetch(503, {
      error: "connection_unavailable",
      message: "Datasource unavailable.",
    });
    const { io, err } = capture();
    const code = await runSqlCommand(["sql", "SELECT 1"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Datasource unavailable.");
  });

  it("surfaces a network/timeout failure", async () => {
    const fetchImpl = (async () => {
      const e = new Error("aborted");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    const { io, err } = capture();
    const code = await runSqlCommand(["sql", "SELECT 1"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Timed out");
  });
});
