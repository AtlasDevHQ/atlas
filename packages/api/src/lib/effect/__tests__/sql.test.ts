import { describe, test, expect } from "bun:test";
import { Effect, Layer, Exit } from "effect";
import {
  AtlasSqlClient,
  createSqlClientTestLayer,
  makeAtlasSqlClientLive,
} from "../sql";
import { createTestLayer } from "../services";

describe("AtlasSqlClient", () => {
  test("createSqlClientTestLayer provides default empty result", async () => {
    const layer = createSqlClientTestLayer();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* AtlasSqlClient;
        const qr = yield* sql.query("SELECT 1");
        return { columns: qr.columns, rows: qr.rows, dbType: sql.dbType };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.dbType).toBe("postgres");
  });

  test("createSqlClientTestLayer accepts custom query result", async () => {
    const layer = createSqlClientTestLayer({
      queryResult: { columns: ["name"], rows: [{ name: "Alice" }] },
      dbType: "mysql",
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* AtlasSqlClient;
        const qr = yield* sql.query("SELECT name FROM users");
        return { rows: qr.rows, dbType: sql.dbType };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.rows).toEqual([{ name: "Alice" }]);
    expect(result.dbType).toBe("mysql");
  });

  test("createSqlClientTestLayer with query error", async () => {
    const layer = createSqlClientTestLayer({
      queryError: new Error("connection refused"),
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sql = yield* AtlasSqlClient;
        return yield* sql.query("SELECT 1");
      }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("makeAtlasSqlClientLive reads from ConnectionRegistry", async () => {
    const mockConn = {
      query: async () => ({
        columns: ["count"],
        rows: [{ count: 42 }],
      }),
      close: async () => {},
    };

    const connLayer = createTestLayer({
      get: () => mockConn,
      has: () => true,
      getDBType: () => "postgres" as const,
    });

    const sqlLayer = makeAtlasSqlClientLive("default");
    const combined = Layer.provide(sqlLayer, connLayer);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* AtlasSqlClient;
        const qr = yield* sql.query("SELECT count(*) FROM users");
        return { count: qr.rows[0]?.count, dbType: sql.dbType };
      }).pipe(Effect.provide(combined)),
    );

    expect(result.count).toBe(42);
    expect(result.dbType).toBe("postgres");
  });

  test("makeAtlasSqlClientLive fails when connection not found", async () => {
    const connLayer = createTestLayer({
      has: () => false,
      get: () => {
        throw new Error("not found");
      },
    });

    const sqlLayer = makeAtlasSqlClientLive("nonexistent");
    const combined = Layer.provide(sqlLayer, connLayer);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sql = yield* AtlasSqlClient;
        return yield* sql.query("SELECT 1");
      }).pipe(Effect.provide(combined)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("connectionId and dbType are accessible", async () => {
    const layer = createSqlClientTestLayer({
      connectionId: "analytics",
      dbType: "postgres",
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* AtlasSqlClient;
        return { id: sql.connectionId, type: sql.dbType };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.id).toBe("analytics");
    expect(result.type).toBe("postgres");
  });
});
