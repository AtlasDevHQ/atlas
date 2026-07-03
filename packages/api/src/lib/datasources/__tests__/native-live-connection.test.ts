/**
 * Tests for `native-live-connection` (#4197) — THE pg-vs-mysql profiler
 * dispatch (`nativeProfilerFor`) and the shared native
 * `LiveDatasourceConnection` assembly (`buildNativeLiveConnection`).
 *
 * Before #4197 the dialect ternary was copy-pasted at three sites and the
 * native connection shape was hand-built twice (mcp-lifecycle's native branch +
 * the env-var byproduct). These tests pin the single home's contract: dispatch
 * per dialect, the schema-default rule (caller > configured > pg "public"),
 * option forwarding, and the caller-delegated query surface.
 */

import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { DatabaseObject, ProfilingResult } from "@useatlas/types";

const emptyResult = (): ProfilingResult => ({ profiles: [], errors: [] });
const noObjects: DatabaseObject[] = [];

const listPostgresObjectsSpy = mock(async (): Promise<DatabaseObject[]> => noObjects);
const listMySQLObjectsSpy = mock(async (): Promise<DatabaseObject[]> => noObjects);
const profilePostgresSpy = mock(async (): Promise<ProfilingResult> => emptyResult());
const profileMySQLSpy = mock(async (): Promise<ProfilingResult> => emptyResult());
mock.module("@atlas/api/lib/profiler", () => ({
  listPostgresObjects: listPostgresObjectsSpy,
  listMySQLObjects: listMySQLObjectsSpy,
  profilePostgres: profilePostgresSpy,
  profileMySQL: profileMySQLSpy,
}));

const { nativeProfilerFor, buildNativeLiveConnection } = await import("../native-live-connection.js");

beforeEach(() => {
  listPostgresObjectsSpy.mockClear();
  listMySQLObjectsSpy.mockClear();
  profilePostgresSpy.mockClear();
  profileMySQLSpy.mockClear();
});

describe("nativeProfilerFor — the one dialect dispatch", () => {
  it("postgres → the postgres pair", async () => {
    const p = nativeProfilerFor("postgres");
    await p.listObjects({ url: "postgresql://h/db" });
    await p.profile({ url: "postgresql://h/db" });
    expect(listPostgresObjectsSpy).toHaveBeenCalledTimes(1);
    expect(profilePostgresSpy).toHaveBeenCalledTimes(1);
    expect(listMySQLObjectsSpy).not.toHaveBeenCalled();
    expect(profileMySQLSpy).not.toHaveBeenCalled();
  });

  it("mysql → the mysql pair", async () => {
    const p = nativeProfilerFor("mysql");
    await p.listObjects({ url: "mysql://h/db" });
    await p.profile({ url: "mysql://h/db" });
    expect(listMySQLObjectsSpy).toHaveBeenCalledTimes(1);
    expect(profileMySQLSpy).toHaveBeenCalledTimes(1);
    expect(listPostgresObjectsSpy).not.toHaveBeenCalled();
    expect(profilePostgresSpy).not.toHaveBeenCalled();
  });
});

describe("buildNativeLiveConnection — schema-default rule (caller > configured > pg public)", () => {
  const base = {
    url: "postgresql://h/db",
    connectionGroupId: null,
    query: async () => ({ columns: [], rows: [] }),
  };

  it("pg, no configured schema: listObjects/profile default to public", async () => {
    const conn = buildNativeLiveConnection({ dbType: "postgres", ...base });
    await conn.listObjects();
    expect(listPostgresObjectsSpy).toHaveBeenCalledWith({ url: base.url, schema: "public" });
    await conn.profile({ selectedTables: ["users"] });
    expect(profilePostgresSpy).toHaveBeenCalledWith({
      url: base.url,
      schema: "public",
      selectedTables: ["users"],
    });
  });

  it("pg, configured schema wins over the public default", async () => {
    const conn = buildNativeLiveConnection({ dbType: "postgres", configuredSchema: "sales", ...base });
    await conn.listObjects();
    expect(listPostgresObjectsSpy).toHaveBeenCalledWith({ url: base.url, schema: "sales" });
  });

  it("caller schema wins over the configured schema", async () => {
    const conn = buildNativeLiveConnection({ dbType: "postgres", configuredSchema: "sales", ...base });
    await conn.profile({ schema: "audit" });
    expect(profilePostgresSpy).toHaveBeenCalledWith({ url: base.url, schema: "audit" });
  });

  it("mysql with no schema anywhere: no schema key is passed", async () => {
    const conn = buildNativeLiveConnection({ dbType: "mysql", ...base, url: "mysql://h/db" });
    await conn.listObjects();
    expect(listMySQLObjectsSpy).toHaveBeenCalledWith({ url: "mysql://h/db" });
    await conn.profile({});
    expect(profileMySQLSpy).toHaveBeenCalledWith({ url: "mysql://h/db" });
  });

  it("forwards prefetchedObjects / progress / logger only when provided", async () => {
    const conn = buildNativeLiveConnection({ dbType: "postgres", ...base });
    const prefetched: DatabaseObject[] = [{ name: "users", type: "table" }];
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    await conn.profile({ prefetchedObjects: prefetched, logger });
    expect(profilePostgresSpy).toHaveBeenCalledWith({
      url: base.url,
      schema: "public",
      prefetchedObjects: prefetched,
      logger,
    });
  });
});

describe("buildNativeLiveConnection — query + close surfaces", () => {
  it("query delegates to the caller-supplied pool routing", async () => {
    const querySpy = mock(async () => ({ columns: ["c"], rows: [{ c: 1 }] }));
    const conn = buildNativeLiveConnection({
      dbType: "postgres",
      url: "postgresql://h/db",
      connectionGroupId: "grp_1",
      query: querySpy,
    });
    const out = await conn.query("SELECT 1", 5000);
    expect(querySpy).toHaveBeenCalledWith("SELECT 1", 5000);
    expect(out.rows).toEqual([{ c: 1 }]);
    expect(conn.connectionGroupId).toBe("grp_1");
  });

  it("close is a no-op (registry-managed pool, profiler-owned throwaway pools)", async () => {
    const conn = buildNativeLiveConnection({
      dbType: "mysql",
      url: "mysql://h/db",
      connectionGroupId: null,
      query: async () => ({ columns: [], rows: [] }),
    });
    await expect(conn.close()).resolves.toBeUndefined();
  });
});
