/**
 * Unit tests for the knowledge-ingest cap readers (#4207, AC #3 "caps via
 * settings"). Pins the coercion/clamp contract (`positiveIntSetting`) and that
 * each reader threads its registry key through it to the documented default.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

let SETTINGS: Record<string, string | undefined> = {};
mock.module("@atlas/api/lib/settings", () => ({
  getSettingAuto: (key: string) => SETTINGS[key],
}));
mock.module("@atlas/api/lib/logger", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return { createLogger: () => logger, getRequestContext: () => ({ requestId: "test" }) };
});

const {
  positiveIntSetting,
  getIngestMaxDocs,
  getIngestMaxDocBytes,
  getIngestMaxBundleBytes,
  DEFAULT_INGEST_MAX_DOCS,
  DEFAULT_INGEST_MAX_DOC_BYTES,
  DEFAULT_INGEST_MAX_BUNDLE_BYTES,
} = await import("@atlas/api/lib/knowledge/ingest-limits");

beforeEach(() => {
  SETTINGS = {};
});
afterEach(() => {
  SETTINGS = {};
});

describe("positiveIntSetting", () => {
  it("returns the fallback when the key is unset", () => {
    expect(positiveIntSetting("K", undefined, 42)).toBe(42);
  });
  it("parses a valid positive integer override", () => {
    expect(positiveIntSetting("K", "50", 42)).toBe(50);
  });
  it("clamps zero / negative / non-numeric overrides back to the fallback", () => {
    expect(positiveIntSetting("K", "0", 42)).toBe(42);
    expect(positiveIntSetting("K", "-5", 42)).toBe(42);
    expect(positiveIntSetting("K", "abc", 42)).toBe(42);
    expect(positiveIntSetting("K", "", 42)).toBe(42);
  });
  it("rejects unit-suffixed / separator-laden / overflow values instead of silent parseInt truncation", () => {
    // Number.parseInt("25MB") is 25 — a fat-fingered cap that would then fail
    // every ingest for a reason no log explains. Require all-digits so these
    // take the warn+fallback path the docblock promises.
    expect(positiveIntSetting("K", "25MB", 42)).toBe(42);
    expect(positiveIntSetting("K", "25_000_000", 42)).toBe(42);
    expect(positiveIntSetting("K", "1e6", 42)).toBe(42);
    expect(positiveIntSetting("K", "9".repeat(20), 42)).toBe(42); // all-digit overflow → fallback
  });
  it("honors a clean integer with surrounding whitespace", () => {
    expect(positiveIntSetting("K", " 50 ", 42)).toBe(50);
  });
});

describe("cap readers thread the registry key → default", () => {
  it("fall back to documented defaults when unset", () => {
    expect(getIngestMaxDocs()).toBe(DEFAULT_INGEST_MAX_DOCS);
    expect(getIngestMaxDocBytes()).toBe(DEFAULT_INGEST_MAX_DOC_BYTES);
    expect(getIngestMaxBundleBytes()).toBe(DEFAULT_INGEST_MAX_BUNDLE_BYTES);
  });
  it("honor a valid platform override", () => {
    SETTINGS.ATLAS_KNOWLEDGE_INGEST_MAX_DOCS = "5";
    SETTINGS.ATLAS_KNOWLEDGE_INGEST_MAX_DOC_BYTES = "2048";
    SETTINGS.ATLAS_KNOWLEDGE_INGEST_MAX_BUNDLE_BYTES = "999";
    expect(getIngestMaxDocs()).toBe(5);
    expect(getIngestMaxDocBytes()).toBe(2048);
    expect(getIngestMaxBundleBytes()).toBe(999);
  });
  it("fall back on a garbage override", () => {
    SETTINGS.ATLAS_KNOWLEDGE_INGEST_MAX_DOCS = "nope";
    expect(getIngestMaxDocs()).toBe(DEFAULT_INGEST_MAX_DOCS);
  });
});
