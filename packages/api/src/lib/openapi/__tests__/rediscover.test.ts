/**
 * Unit tests for the shared re-discovery core (`rediscover.ts`, #2978).
 *
 * The admin-route test already drives `performRediscovery`'s happy path + probe /
 * unsupported-auth branches and the no-watermark `persistRediscoverySnapshot` SQL.
 * This file covers the bits ONLY the scheduler reaches:
 *   - `stampSpecLastChecked` — the watermark-only write that must NOT touch the
 *     snapshot (the "a failed scheduled probe never degrades the live snapshot" AC).
 *   - `persistRediscoverySnapshot` WITH a watermark — the success write that bumps
 *     `spec_last_checked_at` alongside the snapshot + diff.
 *   - `performRediscovery` `decrypt_failed` / `no_url` branches (the route's
 *     passthrough-decrypt fixture can't reach them).
 *
 * Probe is injected via the `deps.probe` seam (no module mock needed); `secrets` is a
 * controllable passthrough; `db/internal` records the issued SQL.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

let queryCalls: Array<{ sql: string; params: unknown[] }> = [];
let decryptShouldThrow = false;

mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => undefined };
});

mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => true,
  internalQuery: async (sql: string, params: unknown[]) => {
    queryCalls.push({ sql, params });
    return [];
  },
  internalExecute: () => {},
  getInternalDB: () => ({}),
}));

mock.module("@atlas/api/lib/plugins/secrets", () => ({
  parseConfigSchema: () => [],
  decryptSecretFields: (config: Record<string, unknown>) => {
    if (decryptShouldThrow) throw new Error("key rotated");
    return { ...config };
  },
}));

mock.module("@atlas/api/lib/audit/error-scrub", () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  causeToError: (_c: unknown) => undefined,
}));

const {
  performRediscovery,
  persistRediscoverySnapshot,
  stampSpecLastChecked,
  buildSpecDiffRecord,
} = await import("../rediscover");

type OperationGraph = import("../types").OperationGraph;
type OpenApiSnapshot = import("../catalog").OpenApiSnapshot;
type SpecDiffRecord = import("../diff").SpecDiffRecord;

const NOW_ISO = "2026-05-31T12:00:00.000Z";

const snapshot: OpenApiSnapshot = {
  probedAt: NOW_ISO,
  title: "Widget API",
  version: "1.0.0",
  openapiVersion: "3.1.0",
  operationCount: 2,
  doc: { openapi: "3.1.0" },
};
const diffRecord: SpecDiffRecord = { previousProbedAt: null, currentProbedAt: NOW_ISO, diff: null };

const emptyGraph: OperationGraph = {
  operations: new Map(),
  schemas: new Map(),
  info: { title: "Widget API", version: "1.0.0", openapiVersion: "3.1.0" },
  servers: [],
} as unknown as OperationGraph;

beforeEach(() => {
  queryCalls = [];
  decryptShouldThrow = false;
});

describe("persistRediscoverySnapshot — success write", () => {
  it("without a watermark writes only snapshot + diff (the manual route's shape)", async () => {
    await persistRediscoverySnapshot("ws-1", "ds-1", snapshot, diffRecord);
    expect(queryCalls).toHaveLength(1);
    const { sql, params } = queryCalls[0];
    expect(sql).toContain("jsonb_build_object('openapi_snapshot', $4::jsonb, 'openapi_last_diff', $5::jsonb)");
    expect(sql).not.toContain("spec_last_checked_at");
    expect(sql).not.toContain("auth_value");
    expect(params).toHaveLength(5);
    expect(params[0]).toBe("ws-1");
    expect(params[1]).toBe("ds-1");
  });

  it("with a watermark appends spec_last_checked_at ($6::text) — the scheduler's success write", async () => {
    await persistRediscoverySnapshot("ws-1", "ds-1", snapshot, diffRecord, NOW_ISO);
    expect(queryCalls).toHaveLength(1);
    const { sql, params } = queryCalls[0];
    expect(sql).toContain("'openapi_snapshot', $4::jsonb");
    expect(sql).toContain("'openapi_last_diff', $5::jsonb");
    expect(sql).toContain("'spec_last_checked_at', $6::text");
    expect(params).toHaveLength(6);
    expect(params[5]).toBe(NOW_ISO);
  });
});

describe("stampSpecLastChecked — watermark-only write (fail-soft negative cache)", () => {
  it("writes ONLY spec_last_checked_at and never touches the snapshot or credential", async () => {
    await stampSpecLastChecked("ws-1", "ds-1", NOW_ISO);
    expect(queryCalls).toHaveLength(1);
    const { sql, params } = queryCalls[0];
    expect(sql).toContain("jsonb_build_object('spec_last_checked_at', $4::text)");
    // The live snapshot + diff + credential are left intact.
    expect(sql).not.toContain("openapi_snapshot");
    expect(sql).not.toContain("openapi_last_diff");
    expect(sql).not.toContain("auth_value");
    expect(params).toEqual(["ws-1", "ds-1", "catalog:openapi-generic", NOW_ISO]);
  });
});

describe("performRediscovery — branches the route fixture can't reach", () => {
  it("returns no_url when the install has no spec URL", async () => {
    const result = await performRediscovery({ auth_kind: "none" }, "ds-1", {
      probe: async () => ({ doc: {}, graph: emptyGraph }),
      now: () => NOW_ISO,
    });
    expect(result.kind).toBe("no_url");
  });

  it("returns decrypt_failed when the credential cannot be decrypted", async () => {
    decryptShouldThrow = true;
    const result = await performRediscovery({ openapi_url: "https://x/openapi.json" }, "ds-1", {
      probe: async () => ({ doc: {}, graph: emptyGraph }),
      now: () => NOW_ISO,
    });
    expect(result.kind).toBe("decrypt_failed");
  });

  it("re-probes via the injected probe and returns ok with a baseline diff (no prior snapshot)", async () => {
    let probedUrl = "";
    const result = await performRediscovery(
      { openapi_url: "https://x/openapi.json", auth_kind: "none" },
      "ds-1",
      {
        probe: async (url) => {
          probedUrl = url;
          return { doc: { openapi: "3.1.0" }, graph: emptyGraph };
        },
        now: () => NOW_ISO,
      },
    );
    expect(probedUrl).toBe("https://x/openapi.json");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.snapshot.probedAt).toBe(NOW_ISO);
      expect(result.diffRecord.diff).toBeNull(); // first-ever discovery → baseline
      expect(result.drift?.baseline).toBe(true);
    }
  });
});

describe("buildSpecDiffRecord — baseline when no valid prior snapshot", () => {
  it("records a first-ever baseline (previousProbedAt null) when prior config has no snapshot", () => {
    const record = buildSpecDiffRecord({}, emptyGraph, NOW_ISO, "ds-1");
    expect(record).toEqual({ previousProbedAt: null, currentProbedAt: NOW_ISO, diff: null });
  });
});
