/**
 * Shared mock factory for EE test files.
 *
 * 8 EE test files mock all three of these modules; 1 additional file
 * (approval.test.ts) uses only the DB and logger mocks:
 *   - `../index` (enterprise gate)
 *   - `@atlas/api/lib/db/internal` (internal DB)
 *   - `@atlas/api/lib/logger` (logger)
 *
 * This factory centralises the default shape so that changes to these
 * modules only need updating here.
 *
 * Usage:
 *   import { createEEMock } from "../__mocks__/internal";
 *   const ee = createEEMock();
 *   mock.module("../index", () => ee.enterpriseMock);
 *   mock.module("@atlas/api/lib/db/internal", () => ee.internalDBMock);
 *   mock.module("@atlas/api/lib/logger", () => ee.loggerMock);
 *
 * @module
 */

import { EnterpriseError } from "../index";

// Re-export so tests can import from the mock factory
export { EnterpriseError };

export interface EEMockOverrides {
  /** Extra exports merged into the enterprise mock (`../index`). */
  enterprise?: Record<string, unknown>;
  /** Extra exports merged into the internal DB mock. */
  internalDB?: Record<string, unknown>;
  /** Extra exports merged into the logger mock. */
  logger?: Record<string, unknown>;
}

export interface EEMock {
  // ── Module mocks (pass directly to mock.module) ──────────────
  enterpriseMock: Record<string, unknown>;
  internalDBMock: Record<string, unknown>;
  loggerMock: Record<string, unknown>;

  // ── State ────────────────────────────────────────────────────
  capturedQueries: { sql: string; params: unknown[] }[];

  // ── Helpers ──────────────────────────────────────────────────
  /** Append row batches to the queue — subsequent internalQuery / getInternalDB().query calls consume them in order. */
  queueMockRows: (...batches: Record<string, unknown>[][]) => void;
  /** Toggle the enterprise-enabled flag. */
  setEnterpriseEnabled: (enabled: boolean) => void;
  /** Set or clear the enterprise license key. */
  setEnterpriseLicenseKey: (key: string | undefined) => void;
  /** Toggle hasInternalDB return value. */
  setHasInternalDB: (has: boolean) => void;
  /** Reset all mock state (call in beforeEach). */
  reset: () => void;
}

/**
 * Returns a fresh set of mocks. Each call creates new objects so tests
 * don't leak state.
 */
export function createEEMock(overrides?: EEMockOverrides): EEMock {
  // ── Mutable state ──────────────────────────────────────────────
  let enterpriseEnabled = true;
  let enterpriseLicenseKey: string | undefined = "test-key";
  let hasInternalDB = true;
  const mockRows: Record<string, unknown>[][] = [];
  let queryCallCount = 0;
  const capturedQueries: { sql: string; params: unknown[] }[] = [];

  // ── Internal DB query handler (shared by internalQuery & getInternalDB) ─
  function handleQuery(sql: string, params?: unknown[]) {
    capturedQueries.push({ sql, params: params ?? [] });
    const rows = mockRows[queryCallCount] ?? [];
    queryCallCount++;
    return rows;
  }

  // ── Enterprise mock ────────────────────────────────────────────
  const enterpriseMock: Record<string, unknown> = {
    isEnterpriseEnabled: () => enterpriseEnabled,
    getEnterpriseLicenseKey: () => enterpriseLicenseKey,
    EnterpriseError,
    requireEnterprise: (feature?: string) => {
      const label = feature ? ` (${feature})` : "";
      if (!enterpriseEnabled) {
        throw new EnterpriseError(
          `Enterprise features${label} are not enabled. ` +
          `Set ATLAS_ENTERPRISE_ENABLED=true or configure enterprise.enabled in atlas.config.ts.`,
        );
      }
    },
    ...overrides?.enterprise,
  };

  // ── Internal DB mock ───────────────────────────────────────────
  const internalDBMock: Record<string, unknown> = {
    hasInternalDB: () => hasInternalDB,
    getInternalDB: () => ({
      query: async (sql: string, params?: unknown[]) => {
        const rows = handleQuery(sql, params);
        return { rows, rowCount: rows.length };
      },
      end: async () => {},
      on: () => {},
    }),
    internalQuery: async (sql: string, params?: unknown[]) => {
      return handleQuery(sql, params);
    },
    internalExecute: () => {},
    encryptUrl: (v: string) => `encrypted:${v}`,
    decryptUrl: (v: string) => (v.startsWith("encrypted:") ? v.slice(10) : v),
    getEncryptionKey: () => Buffer.from("test-key-32-bytes-long-enough!!!"),
    closeInternalDB: async () => {},
    migrateInternalDB: async () => {},
    _resetPool: () => {},
    loadSavedConnections: async () => 0,
    ...overrides?.internalDB,
  };

  // ── Logger mock ────────────────────────────────────────────────
  const loggerMock: Record<string, unknown> = {
    createLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
    ...overrides?.logger,
  };

  // ── Helpers ────────────────────────────────────────────────────
  function queueMockRows(...batches: Record<string, unknown>[][]) {
    mockRows.push(...batches);
  }

  function setEnterpriseEnabled(enabled: boolean) {
    enterpriseEnabled = enabled;
  }

  function setEnterpriseLicenseKey(key: string | undefined) {
    enterpriseLicenseKey = key;
  }

  function setHasInternalDB(has: boolean) {
    hasInternalDB = has;
  }

  function reset() {
    mockRows.length = 0;
    queryCallCount = 0;
    capturedQueries.length = 0;
    enterpriseEnabled = true;
    enterpriseLicenseKey = "test-key";
    hasInternalDB = true;
  }

  return {
    enterpriseMock,
    internalDBMock,
    loggerMock,
    capturedQueries,
    queueMockRows,
    setEnterpriseEnabled,
    setEnterpriseLicenseKey,
    setHasInternalDB,
    reset,
  };
}
