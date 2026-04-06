import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  isExpertSchedulerEnabled,
  getExpertSchedulerIntervalMs,
  DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS,
} from "../scheduler";

// Mock internal DB
mock.module("@atlas/api/lib/db/internal", () => ({
  hasInternalDB: () => false,
  getInternalDB: () => ({ query: async () => ({ rows: [] }), end: async () => {}, on: () => {} }),
  internalQuery: async () => [],
  internalExecute: () => {},
  getAutoApproveThreshold: () => 2, // disabled
  getAutoApproveTypes: () => new Set(["update_description", "add_dimension"]),
  insertSemanticAmendment: mock(async () => ({ id: "test-id", status: "pending" as const })),
  getPendingAmendmentCount: mock(async () => 0),
  getApprovedPatterns: async () => [],
  getEncryptionKey: () => null,
  encryptConnectionUrl: (url: string) => url,
  decryptConnectionUrl: (url: string) => url,
  setWorkspaceRegion: mock(async () => {}),
}));

// Mock logger
mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

describe("isExpertSchedulerEnabled", () => {
  beforeEach(() => {
    delete process.env.ATLAS_EXPERT_SCHEDULER_ENABLED;
  });

  it("returns false when not set", () => {
    expect(isExpertSchedulerEnabled()).toBe(false);
  });

  it("returns true when set to 'true'", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_ENABLED = "true";
    expect(isExpertSchedulerEnabled()).toBe(true);
  });

  it("returns true when set to '1'", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_ENABLED = "1";
    expect(isExpertSchedulerEnabled()).toBe(true);
  });

  it("returns false for other values", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_ENABLED = "yes";
    expect(isExpertSchedulerEnabled()).toBe(false);
  });
});

describe("getExpertSchedulerIntervalMs", () => {
  beforeEach(() => {
    delete process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS;
  });

  it("returns default when not set", () => {
    expect(getExpertSchedulerIntervalMs()).toBe(DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS);
  });

  it("converts hours to milliseconds", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS = "12";
    expect(getExpertSchedulerIntervalMs()).toBe(12 * 60 * 60 * 1000);
  });

  it("returns default for invalid values", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS = "abc";
    expect(getExpertSchedulerIntervalMs()).toBe(DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS);
  });

  it("returns default for zero", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS = "0";
    expect(getExpertSchedulerIntervalMs()).toBe(DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS);
  });

  it("returns default for negative", () => {
    process.env.ATLAS_EXPERT_SCHEDULER_INTERVAL_HOURS = "-5";
    expect(getExpertSchedulerIntervalMs()).toBe(DEFAULT_EXPERT_SCHEDULER_INTERVAL_MS);
  });
});
