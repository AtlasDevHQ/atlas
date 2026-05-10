import { describe, expect, it, mock } from "bun:test";

const validateSQLMock = mock(async (sql: string, _connectionId?: string) => {
  if (/drop|insert|update|delete/i.test(sql)) {
    return { valid: false as const, error: "SQL must be SELECT-only." };
  }
  if (/forbidden_table/i.test(sql)) {
    return { valid: false as const, error: 'Table "forbidden_table" is not in the semantic layer.' };
  }
  return { valid: true as const, classification: { tablesAccessed: [], columnsAccessed: [] } };
});

mock.module("@atlas/api/lib/tools/sql", () => ({
  validateSQL: validateSQLMock,
}));

const { proposeDashboard } = await import("@atlas/api/lib/tools/propose-dashboard");

type ExecuteFn = NonNullable<typeof proposeDashboard.execute>;
type ExecuteParams = Parameters<ExecuteFn>[0];

async function run(args: ExecuteParams) {
  const fn = proposeDashboard.execute as ExecuteFn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await fn(args, undefined as any)) as
    | {
        kind: "ok";
        spec: { title: string; description?: string; cards: { title: string; sql: string }[] };
        validation: { allValid: boolean; errors: { cardIndex: number; cardTitle: string; error: string }[] };
      }
    | { kind: "err"; error: string };
}

describe("proposeDashboard tool", () => {
  it("returns kind: 'ok' with allValid=true for valid SELECTs", async () => {
    const result = await run({
      title: "Revenue",
      cards: [
        {
          title: "Total revenue",
          sql: "SELECT SUM(amount) AS total FROM orders",
          chartConfig: { type: "table", categoryColumn: "total", valueColumns: ["total"] },
        },
      ],
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.validation.allValid).toBe(true);
      expect(result.validation.errors).toEqual([]);
      expect(result.spec.cards).toHaveLength(1);
    }
  });

  it("marks invalid SQL with per-card validation errors but still ships the spec", async () => {
    const result = await run({
      title: "Mixed",
      cards: [
        {
          title: "Ok card",
          sql: "SELECT 1",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
        {
          title: "Mutation",
          sql: "DROP TABLE orders",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
        {
          title: "Bad whitelist",
          sql: "SELECT * FROM forbidden_table",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
      ],
    });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.validation.allValid).toBe(false);
      expect(result.validation.errors).toHaveLength(2);
      // Carries cardIndex so the frontend can correlate to the spec position
      expect(result.validation.errors[0]).toMatchObject({ cardIndex: 1, cardTitle: "Mutation" });
      expect(result.validation.errors[1]).toMatchObject({ cardIndex: 2, cardTitle: "Bad whitelist" });
      // Spec still ships all 3 — the route layer re-validates server-side
      expect(result.spec.cards).toHaveLength(3);
    }
  });

  it("invokes validateSQL once per card and threads connectionId through", async () => {
    validateSQLMock.mockClear();
    await run({
      title: "Multi-source",
      cards: [
        {
          title: "Default",
          sql: "SELECT 1",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
        {
          title: "Replica",
          sql: "SELECT 2",
          chartConfig: { type: "table", categoryColumn: "y", valueColumns: ["y"] },
          connectionId: "analytics-replica",
        },
      ],
    });
    expect(validateSQLMock).toHaveBeenCalledTimes(2);
    expect(validateSQLMock.mock.calls[0]).toEqual(["SELECT 1", undefined]);
    expect(validateSQLMock.mock.calls[1]).toEqual(["SELECT 2", "analytics-replica"]);
  });

  it("returns kind: 'err' with a sanitized message on unexpected throw", async () => {
    validateSQLMock.mockImplementationOnce(() => {
      throw new Error("postgresql://atlas:supersecret@db.example/atlas — pool exhausted");
    });
    const result = await run({
      title: "Boom",
      cards: [
        {
          title: "Will throw",
          sql: "SELECT 1",
          chartConfig: { type: "table", categoryColumn: "x", valueColumns: ["x"] },
        },
      ],
    });
    expect(result.kind).toBe("err");
    if (result.kind === "err") {
      expect(result.error).not.toContain("supersecret");
      expect(result.error).not.toContain("postgresql://");
      expect(result.error).toMatch(/dashboard tool failed/i);
    }
  });
});
