/**
 * Tests for `atlas proactive` — replaces internal/enable-proactive-dogfood.ts
 * and internal/disable-proactive-dogfood.ts. Asserts the subcommand issues
 * the right SQL with the right args against a mocked pool, and that the
 * top-level handler's arg-parsing guards refuse invalid invocations.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  enableProactive,
  disableProactive,
  resolveWorkspaceId,
  handleProactive,
  type ProactivePgClient,
} from "../commands/proactive";

// --- Mock pool factory ---

interface MockQuery {
  sql: string;
  params: unknown[];
}

function createMockClient(
  responses: Array<{ rows: Array<Record<string, unknown>>; rowCount?: number }>,
): { client: ProactivePgClient; queries: MockQuery[] } {
  const queries: MockQuery[] = [];
  let nextResponse = 0;
  const client: ProactivePgClient = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const r = responses[nextResponse++] ?? { rows: [], rowCount: 0 };
      return { rows: r.rows as never[], rowCount: r.rowCount ?? r.rows.length };
    },
  };
  return { client, queries };
}

// --- resolveWorkspaceId ---

describe("resolveWorkspaceId", () => {
  it("returns the value unchanged when it starts with `org_`", async () => {
    const { client, queries } = createMockClient([]);
    const id = await resolveWorkspaceId(client, "org_abc123");
    expect(id).toBe("org_abc123");
    expect(queries).toHaveLength(0);
  });

  it("resolves a slug via `organization.slug = $1`", async () => {
    const { client, queries } = createMockClient([
      { rows: [{ id: "org_resolved" }] },
    ]);
    const id = await resolveWorkspaceId(client, "atlas");
    expect(id).toBe("org_resolved");
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("FROM organization WHERE slug = $1");
    expect(queries[0]!.sql).toContain("deleted_at IS NULL");
    expect(queries[0]!.params).toEqual(["atlas"]);
  });

  it("throws when the slug has no match", async () => {
    const { client } = createMockClient([{ rows: [] }]);
    await expect(resolveWorkspaceId(client, "missing")).rejects.toThrow(
      "No organization with slug='missing' found.",
    );
  });

  it("throws when multiple rows match a slug (corruption guard)", async () => {
    const { client } = createMockClient([
      { rows: [{ id: "org_a" }, { id: "org_b" }] },
    ]);
    await expect(resolveWorkspaceId(client, "atlas")).rejects.toThrow(
      "Expected one organization for slug='atlas', found 2.",
    );
  });
});

// --- enableProactive ---

describe("enableProactive", () => {
  it("upserts workspace_proactive_config + one row per channel inside a transaction", async () => {
    const { client, queries } = createMockClient([
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [{ id: "org_42" }] }, // resolve
      { rows: [], rowCount: 1 }, // workspace upsert
      { rows: [], rowCount: 1 }, // channel 1 upsert
      { rows: [], rowCount: 1 }, // channel 2 upsert
      { rows: [], rowCount: 0 }, // COMMIT
    ]);

    const result = await enableProactive(client, {
      workspace: "atlas",
      channels: ["C0AAA", "C0BBB"],
    });

    expect(result).toEqual({ orgId: "org_42", channelCount: 2 });

    // Transaction boundaries
    expect(queries[0]!.sql).toBe("BEGIN");
    expect(queries[queries.length - 1]!.sql).toBe("COMMIT");

    // Workspace upsert
    const wsUpsert = queries.find((q) =>
      q.sql.includes("INSERT INTO workspace_proactive_config"),
    );
    expect(wsUpsert).toBeDefined();
    expect(wsUpsert!.sql).toContain("ON CONFLICT (workspace_id) DO UPDATE");
    expect(wsUpsert!.sql).toContain("enabled = true");
    expect(wsUpsert!.params).toEqual(["org_42"]);

    // One channel upsert per channel, in given order
    const channelUpserts = queries.filter((q) =>
      q.sql.includes("INSERT INTO channel_proactive_config"),
    );
    expect(channelUpserts).toHaveLength(2);
    expect(channelUpserts[0]!.params).toEqual(["org_42", "C0AAA"]);
    expect(channelUpserts[1]!.params).toEqual(["org_42", "C0BBB"]);
    expect(channelUpserts[0]!.sql).toContain(
      "ON CONFLICT (workspace_id, channel_id) DO UPDATE",
    );
  });

  it("rolls back when the resolve query fails (missing org)", async () => {
    const { client, queries } = createMockClient([
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [] }, // resolve — empty
      { rows: [], rowCount: 0 }, // ROLLBACK
    ]);
    await expect(
      enableProactive(client, { workspace: "ghost", channels: ["C0"] }),
    ).rejects.toThrow("No organization with slug='ghost' found.");
    expect(queries[queries.length - 1]!.sql).toBe("ROLLBACK");
  });

  it("refuses to run with zero channels", async () => {
    const { client } = createMockClient([]);
    await expect(
      enableProactive(client, { workspace: "atlas", channels: [] }),
    ).rejects.toThrow("enable requires at least one --channels value");
  });
});

// --- disableProactive ---

describe("disableProactive", () => {
  it("issues an UPDATE setting enabled=false without touching channel rows", async () => {
    const { client, queries } = createMockClient([
      { rows: [{ id: "org_99" }] }, // resolve
      { rows: [], rowCount: 1 }, // UPDATE
    ]);
    const result = await disableProactive(client, { workspace: "atlas" });
    expect(result).toEqual({ orgId: "org_99", affected: 1 });
    const update = queries.find((q) => q.sql.includes("UPDATE workspace_proactive_config"));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("enabled = false");
    expect(update!.params).toEqual(["org_99"]);
    // No channel_proactive_config writes
    expect(queries.some((q) => q.sql.includes("channel_proactive_config"))).toBe(false);
  });

  it("reports affected=0 when no workspace row exists", async () => {
    const { client } = createMockClient([
      { rows: [{ id: "org_99" }] },
      { rows: [], rowCount: 0 },
    ]);
    const result = await disableProactive(client, { workspace: "atlas" });
    expect(result.affected).toBe(0);
  });
});

// --- handleProactive arg-parsing guards ---

const errors: string[] = [];
const logs: string[] = [];
const origConsoleError = console.error;
const origConsoleLog = console.log;
const origExit = process.exit;

let exitCode: number | null = null;

beforeEach(() => {
  errors.length = 0;
  logs.length = 0;
  exitCode = null;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__process_exit__:${exitCode}`);
  }) as unknown as typeof process.exit;
});

afterEach(() => {
  console.error = origConsoleError;
  console.log = origConsoleLog;
  process.exit = origExit;
});

describe("handleProactive — arg-parsing guards", () => {
  it("exits 1 when no subcommand is given", async () => {
    let caught: Error | null = null;
    try {
      await handleProactive(["proactive"]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(errors.some((line) => line.includes("Usage: atlas proactive"))).toBe(true);
  });

  it("exits 1 when --workspace is omitted from `enable`", async () => {
    let caught: Error | null = null;
    try {
      await handleProactive(["proactive", "enable", "--channels", "C0"]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(errors.some((line) => line.includes("--workspace"))).toBe(true);
  });

  it("exits 1 when --channels is omitted from `enable`", async () => {
    let caught: Error | null = null;
    try {
      await handleProactive(["proactive", "enable", "--workspace", "atlas"]);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }
    expect(caught?.message).toBe("__process_exit__:1");
    expect(errors.some((line) => line.includes("--channels"))).toBe(true);
  });
});
