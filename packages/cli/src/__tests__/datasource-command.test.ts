import { describe, it, expect } from "bun:test";

import { runDatasource, type DatasourceIO, type DatasourceRunDeps } from "../commands/datasource";
import type { StoredSession } from "../lib/credentials";
import type { SecretCaptureDeps } from "../lib/datasource-secret";

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

/** Like stubFetch but captures request headers so the credential path is assertable. */
function stubFetchHeaders(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers as Record<string, string>).forEach((v, k) => {
        headers[k] = v;
      });
    }
    calls.push({ url: typeof url === "string" ? url : url.toString(), headers });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("runDatasource — workspace API key (#4112 unattended CI)", () => {
  it("sends the key on x-api-key (not Authorization) when ATLAS_API_KEY is set, with no session", async () => {
    const { fetchImpl, calls } = stubFetchHeaders(200, { connections: [] });
    const { io } = capture();
    const code = await runDatasource(
      ["datasource", "list"],
      { baseUrl: BASE, session: null, apiKey: "atlas_wk_abc", fetchImpl },
      io,
    );
    expect(code).toBe(0);
    expect(calls[0].headers["x-api-key"]).toBe("atlas_wk_abc");
    expect(calls[0].headers["authorization"]).toBeUndefined();
  });

  it("the --api-key flag overrides ATLAS_API_KEY (deps.apiKey)", async () => {
    const { fetchImpl, calls } = stubFetchHeaders(200, { connections: [] });
    const { io } = capture();
    const code = await runDatasource(
      ["datasource", "list", "--api-key", "flag_key"],
      { baseUrl: BASE, session: null, apiKey: "env_key", fetchImpl },
      io,
    );
    expect(code).toBe(0);
    expect(calls[0].headers["x-api-key"]).toBe("flag_key");
  });

  it("does not mistake the --api-key value for the datasource id positional", async () => {
    const { fetchImpl, calls } = stubFetchHeaders(200, { id: "prod-us", dbType: "postgres" });
    const { io } = capture();
    const code = await runDatasource(
      ["datasource", "get", "--api-key", "flag_key", "prod-us"],
      { baseUrl: BASE, session: null, fetchImpl },
      io,
    );
    expect(code).toBe(0);
    expect(calls[0].url).toBe(`${BASE}/api/v1/admin/connections/prod-us`);
  });

  it("the api-key path takes precedence over a stored session", async () => {
    const { fetchImpl, calls } = stubFetchHeaders(200, { connections: [] });
    const { io } = capture();
    await runDatasource(
      ["datasource", "list"],
      { baseUrl: BASE, session: SESSION, apiKey: "atlas_wk_abc", fetchImpl },
      io,
    );
    expect(calls[0].headers["x-api-key"]).toBe("atlas_wk_abc");
    expect(calls[0].headers["authorization"]).toBeUndefined();
  });

  it("list --json falls back to a null workspaceId on the api-key path (no local session)", async () => {
    // `id` + `dbType` are the `ConnectionInfoSchema`-required fields (#4111).
    const { fetchImpl } = stubFetchHeaders(200, { connections: [{ id: "prod-us", dbType: "postgres" }] });
    const { io, out } = capture();
    const code = await runDatasource(
      ["datasource", "list", "--json"],
      { baseUrl: BASE, session: null, apiKey: "atlas_wk_abc", fetchImpl },
      io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.workspaceId).toBeNull();
    expect(parsed.datasources[0].id).toBe("prod-us");
  });

  it("create does not mistake the --api-key value for the id positional", async () => {
    const { fetchImpl, bodies } = stubFetchCapturing(201, { id: "prod-us", dbType: "postgres" });
    const { io } = capture();
    const code = await runDatasource(
      ["datasource", "create", "--api-key", "flag_key", "prod-us"],
      {
        baseUrl: BASE,
        session: null,
        apiKey: "env_key",
        fetchImpl,
        secretCapture: secretDeps({ envValue: "postgres://u:p@h/db" }),
      },
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(bodies[0]).id).toBe("prod-us");
  });

  it("with neither a session nor an api-key, refuses with a login + ATLAS_API_KEY hint", async () => {
    const { io, err } = capture();
    const code = await runDatasource(["datasource", "list"], deps(undefined, null), io);
    expect(code).toBe(1);
    const joined = err.join("\n");
    expect(joined).toContain("atlas login");
    expect(joined).toContain("ATLAS_API_KEY");
  });
});

describe("runDatasource — list (#4044)", () => {
  it("renders a table of the workspace's datasources", async () => {
    const { fetchImpl } = stubFetch(200, {
      connections: [
        {
          id: "prod-us",
          dbType: "postgres",
          status: "published",
          groupId: "prod",
          // Full health object — `ConnectionInfoSchema` validates the nested
          // `ConnectionHealth` (latencyMs + ISO checkedAt are required).
          health: { status: "healthy", latencyMs: 5, checkedAt: "2026-06-29T00:00:00.000Z" },
        },
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
    // `id` + `dbType` are the `ConnectionInfoSchema`-required fields.
    const { fetchImpl } = stubFetch(200, { connections: [{ id: "prod-us", dbType: "postgres" }] });
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

  it("get --json emits the detail as schema-normalized JSON, not the rendered block", async () => {
    const { fetchImpl } = stubFetch(200, { id: "prod-us", dbType: "postgres" });
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "get", "prod-us", "--json"], deps(fetchImpl), io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    // The client parses through `ConnectionDetailSchema`, so `--json` emits a
    // stable detail shape: the create/get-response subset is filled with the
    // server's own `?? null` / `?? false` defaults (a real get response already
    // carries these fields, so this only normalizes a minimal body).
    expect(parsed).toEqual({
      id: "prod-us",
      dbType: "postgres",
      description: null,
      health: null,
      maskedUrl: null,
      schema: null,
      managed: false,
    });
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

/** Secret-capture deps for create tests; `promptSecret` throws unless overridden. */
function secretDeps(over: Partial<SecretCaptureDeps> = {}): SecretCaptureDeps {
  return {
    envValue: undefined,
    isTTY: false,
    promptSecret: async () => {
      throw new Error("promptSecret should not have been called");
    },
    ...over,
  };
}

/** A canned fetch that records the request body so create's payload can be asserted. */
function stubFetchCapturing(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string") bodies.push(init.body);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

describe("runDatasource — create secret capture (#4051)", () => {
  it("captures the URL from the env var and POSTs it, never reading argv", async () => {
    const { fetchImpl, bodies } = stubFetchCapturing(201, {
      id: "prod-us",
      dbType: "postgres",
      maskedUrl: "postgres://***@host/db",
    });
    const { io, out } = capture();
    const code = await runDatasource(
      ["datasource", "create", "prod-us"],
      { ...deps(fetchImpl), secretCapture: secretDeps({ envValue: "postgres://user:pw@host/db" }) },
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(bodies[0]).url).toBe("postgres://user:pw@host/db");
    const text = out.join("\n");
    expect(text).toContain('Created datasource "prod-us"');
    expect(text).toContain("draft");
    // The masked url is shown; the plaintext secret never is.
    expect(text).toContain("postgres://***@host/db");
    expect(text).not.toContain("pw@host");
  });

  it("prompts on stdin when there is a TTY and no env var", async () => {
    const { fetchImpl, bodies } = stubFetchCapturing(201, { id: "ds1", dbType: "mysql" });
    const { io, out } = capture();
    const code = await runDatasource(
      ["datasource", "create", "ds1"],
      {
        ...deps(fetchImpl),
        secretCapture: secretDeps({ isTTY: true, promptSecret: async () => "mysql://u:p@h/db" }),
      },
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(bodies[0]).url).toBe("mysql://u:p@h/db");
    expect(out.join("\n")).toContain("from stdin");
  });

  it("forwards non-secret metadata flags into the request", async () => {
    const { fetchImpl, bodies } = stubFetchCapturing(201, { id: "ds1" });
    const { io } = capture();
    await runDatasource(
      ["datasource", "create", "ds1", "--description", "US prod", "--schema", "public", "--group", "prod"],
      { ...deps(fetchImpl), secretCapture: secretDeps({ envValue: "postgres://u:p@h/db" }) },
      io,
    );
    const payload = JSON.parse(bodies[0]);
    expect(payload).toEqual({
      id: "ds1",
      url: "postgres://u:p@h/db",
      description: "US prod",
      schema: "public",
      connectionGroupId: "prod",
    });
  });

  it("CI with no TTY and no env var defers to the dashboard/MCP and exits 1", async () => {
    // fetch must NOT be called — no secret was captured.
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    const { io, err } = capture();
    const code = await runDatasource(
      ["datasource", "create", "ds1"],
      { ...deps(fetchImpl), secretCapture: secretDeps({ isTTY: false, envValue: undefined }) },
      io,
    );
    expect(code).toBe(1);
    expect(fetched).toBe(false);
    const text = err.join("\n");
    expect(text).toContain("dashboard or the Atlas MCP");
    expect(text).toContain("ATLAS_DATASOURCE_SECRET");
  });

  it("a set-but-blank env var defers as a misconfiguration (exit 1, never POSTs)", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    const { io, err } = capture();
    const code = await runDatasource(
      ["datasource", "create", "ds1"],
      // isTTY:true would allow a prompt — assert the blank env var is a hard stop,
      // not a silent fall-through (promptSecret throws if reached).
      { ...deps(fetchImpl), secretCapture: secretDeps({ envValue: "   ", isTTY: true }) },
      io,
    );
    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(err.join("\n")).toContain("set but empty");
  });

  it("an empty stdin entry defers (exit 1) and tells the user to paste the URL", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    const { io, err } = capture();
    const code = await runDatasource(
      ["datasource", "create", "ds1"],
      { ...deps(fetchImpl), secretCapture: secretDeps({ isTTY: true, promptSecret: async () => "  " }) },
      io,
    );
    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(err.join("\n")).toContain("No connection URL was entered");
  });

  it("the request url is the captured secret, never a flag value (argv-boundary contract)", async () => {
    // Metadata flags (incl. ones whose values look like URLs) must never become
    // the connection url; the only url is the captured secret. Guards the
    // createPositionalId / flagValue argv boundary the whole feature defends.
    const { fetchImpl, bodies } = stubFetchCapturing(201, { id: "ds1" });
    const { io } = capture();
    await runDatasource(
      ["datasource", "create", "ds1", "--description", "postgres://decoy:decoy@evil/db", "--schema", "public"],
      { ...deps(fetchImpl), secretCapture: secretDeps({ envValue: "postgres://real:real@host/db" }) },
      io,
    );
    const payload = JSON.parse(bodies[0]);
    expect(payload.url).toBe("postgres://real:real@host/db");
    expect(payload.id).toBe("ds1");
    expect(payload.description).toBe("postgres://decoy:decoy@evil/db");
  });

  it("id positional after value-taking flags is parsed correctly (not the flag's value)", async () => {
    const { fetchImpl, bodies } = stubFetchCapturing(201, { id: "prod-us" });
    const { io } = capture();
    const code = await runDatasource(
      ["datasource", "create", "--description", "US prod", "prod-us"],
      { ...deps(fetchImpl), secretCapture: secretDeps({ envValue: "postgres://u:p@h/db" }) },
      io,
    );
    expect(code).toBe(0);
    const payload = JSON.parse(bodies[0]);
    expect(payload.id).toBe("prod-us");
    expect(payload.description).toBe("US prod");
  });

  it("a cancelled prompt is a clean no-op (exit 0, nothing created)", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;
    const { io } = capture();
    const code = await runDatasource(
      ["datasource", "create", "ds1"],
      { ...deps(fetchImpl), secretCapture: secretDeps({ isTTY: true, promptSecret: async () => null }) },
      io,
    );
    expect(code).toBe(0);
    expect(fetched).toBe(false);
  });

  it("requires an id positional", async () => {
    const { io, err } = capture();
    const code = await runDatasource(
      ["datasource", "create"],
      { ...deps(undefined), secretCapture: secretDeps({ envValue: "postgres://u:p@h/db" }) },
      io,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("atlas datasource create <id>");
  });

  it("rejects --group and --new-group together before capturing any secret", async () => {
    const { io, err } = capture();
    const code = await runDatasource(
      ["datasource", "create", "ds1", "--group", "a", "--new-group", "b"],
      // promptSecret throws if reached — assert the conflict is caught first.
      { ...deps(undefined), secretCapture: secretDeps({ isTTY: true }) },
      io,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not both");
  });

  it("surfaces a server connection_failed as an actionable error", async () => {
    const { fetchImpl } = stubFetchCapturing(400, {
      error: "connection_failed",
      message: "Connection test failed: timeout. Fix the URL and try again.",
    });
    const { io, err } = capture();
    const code = await runDatasource(
      ["datasource", "create", "ds1"],
      { ...deps(fetchImpl), secretCapture: secretDeps({ envValue: "postgres://u:p@h/db" }) },
      io,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Fix the URL");
  });

  it("--json emits the raw created detail", async () => {
    const { fetchImpl } = stubFetchCapturing(201, { id: "ds1", dbType: "postgres", maskedUrl: "postgres://***@h/db" });
    const { io, out } = capture();
    const code = await runDatasource(
      ["datasource", "create", "ds1", "--json"],
      { ...deps(fetchImpl), secretCapture: secretDeps({ envValue: "postgres://u:p@h/db" }) },
      io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.id).toBe("ds1");
    expect(parsed.maskedUrl).toBe("postgres://***@h/db");
  });
});

/** A fetch stub that returns an NDJSON stream body (200) from the given lines. */
function stubNdjson(lines: Array<Record<string, unknown>>): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${typeof url === "string" ? url : url.toString()}`);
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("runDatasource — profile (#4052)", () => {
  const okStream = [
    { type: "start", total: 2 },
    { type: "table", name: "orders", index: 0, total: 2, status: "done" },
    { type: "table", name: "users", index: 1, total: 2, status: "done" },
    {
      type: "result",
      id: "prod-us",
      queryable: true,
      persisted: true,
      persistedStatus: "draft",
      entitiesGenerated: 2,
      metricsGenerated: 1,
      tables: ["orders", "users"],
      profilingErrors: 0,
      incomplete: false,
      elapsedMs: 1234,
    },
  ];

  it("profiles and reports the generated draft layer", async () => {
    const { fetchImpl, calls } = stubNdjson(okStream);
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "profile", "prod-us"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(calls[0]).toContain("POST http://localhost:3001/api/v1/datasources/prod-us/profile");
    const text = out.join("\n");
    expect(text).toContain("2 entities");
    expect(text).toContain("draft");
  });

  it("profile without an id errors", async () => {
    const { io, err } = capture();
    const code = await runDatasource(["datasource", "profile"], deps(undefined), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("atlas datasource profile <id>");
  });

  it("profile --json emits the terminal result object", async () => {
    const { fetchImpl } = stubNdjson(okStream);
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "profile", "prod-us", "--json"], deps(fetchImpl), io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.entitiesGenerated).toBe(2);
    expect(parsed.persistedStatus).toBe("draft");
  });

  it("surfaces an incomplete profile (some tables failed)", async () => {
    const { fetchImpl } = stubNdjson([
      { type: "start", total: 2 },
      { type: "table", name: "orders", index: 0, total: 2, status: "done" },
      { type: "table", name: "users", index: 1, total: 2, status: "error", error: "permission denied" },
      {
        type: "result",
        id: "prod-us",
        queryable: true,
        persisted: true,
        persistedStatus: "draft",
        entitiesGenerated: 1,
        metricsGenerated: 0,
        tables: ["orders"],
        profilingErrors: 1,
        incomplete: true,
        incompleteTables: ["users"],
        elapsedMs: 500,
      },
    ]);
    const { io, out } = capture();
    const code = await runDatasource(["datasource", "profile", "prod-us"], deps(fetchImpl), io);
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("incomplete");
    expect(text).toContain("users");
  });

  it("a terminal error event becomes a non-zero exit with the server message", async () => {
    const { fetchImpl } = stubNdjson([
      { type: "start", total: 0 },
      { type: "error", error: "profiling_failed", message: "The datasource has no profilable tables." },
    ]);
    const { io, err } = capture();
    const code = await runDatasource(["datasource", "profile", "prod-us"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("no profilable tables");
  });

  it("a non-admin member is denied (403) with an actionable message before the stream", async () => {
    const { fetchImpl } = stubFetch(403, { error: "forbidden_role", message: "Admin role required." });
    const { io, err } = capture();
    const code = await runDatasource(["datasource", "profile", "prod-us"], deps(fetchImpl), io);
    expect(code).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("admin role");
  });

  it("a 404 maps to an actionable not-found message", async () => {
    const { fetchImpl } = stubFetch(404, { error: "not_found", message: "Datasource not found." });
    const { io, err } = capture();
    const code = await runDatasource(["datasource", "profile", "ghost"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not found");
  });

  it("a 409 reconnect-required surfaces the reconnect guidance", async () => {
    const { fetchImpl } = stubFetch(409, {
      error: "reconnect_required",
      message: "Reconnect Salesforce in Admin → Integrations, then retry.",
    });
    const { io, err } = capture();
    const code = await runDatasource(["datasource", "profile", "sfdc"], deps(fetchImpl), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Reconnect");
  });
});

describe("runDatasource — unexpected errors are surfaced, not swallowed (#4044)", () => {
  it("an unexpected (non-DatasourceCliError) throw becomes an `Unexpected error` line + exit 1", async () => {
    // A schema-valid entry (id + dbType) so `listDatasources` succeeds and the
    // render-time throw below is what surfaces (not a parse rejection).
    const { fetchImpl } = stubFetch(200, { connections: [{ id: "x", dbType: "postgres" }] });
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
