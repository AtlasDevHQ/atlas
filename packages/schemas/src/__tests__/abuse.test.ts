import { describe, expect, test } from "bun:test";
import {
  AbuseEventSchema,
  AbuseStatusSchema,
  AbuseDetailSchema,
  AbuseThresholdConfigSchema,
  AbuseCountersSchema,
  AbuseInstanceSchema,
} from "../abuse";

const validEvent = {
  id: "evt_1",
  workspaceId: "org_1",
  level: "warning" as const,
  trigger: "query_rate" as const,
  message: "Rate exceeded",
  metadata: { queryCount: 120 },
  createdAt: "2026-04-19T12:00:00.000Z",
  actor: "system",
};

const validStatus = {
  workspaceId: "org_1",
  workspaceName: "Acme Corp",
  level: "throttled" as const,
  trigger: "error_rate" as const,
  message: "Too many failed queries",
  updatedAt: "2026-04-19T12:00:00.000Z",
  events: [validEvent],
};

const validThresholds = {
  queryRateLimit: 1000,
  queryRateWindowSeconds: 60,
  errorRateThreshold: 0.5,
  uniqueTablesLimit: 50,
  throttleDelayMs: 200,
};

const validCounters = {
  queryCount: 1200,
  errorCount: 600,
  errorRatePct: 50,
  uniqueTablesAccessed: 12,
  escalations: 2,
};

const validInstance = {
  startedAt: "2026-04-19T11:00:00.000Z",
  endedAt: null,
  peakLevel: "throttled" as const,
  events: [validEvent],
};

const validDetail = {
  workspaceId: "org_1",
  workspaceName: "Acme Corp",
  level: "throttled" as const,
  trigger: "error_rate" as const,
  message: "Too many failed queries",
  updatedAt: "2026-04-19T12:00:00.000Z",
  counters: validCounters,
  thresholds: validThresholds,
  currentInstance: validInstance,
  priorInstances: [],
};

// ---------------------------------------------------------------------------
// Happy-path round-trips
// ---------------------------------------------------------------------------

describe("happy-path parses", () => {
  test("AbuseEventSchema parses a valid event", () => {
    expect(AbuseEventSchema.parse(validEvent)).toEqual(validEvent);
  });

  test("AbuseStatusSchema parses a valid status", () => {
    expect(AbuseStatusSchema.parse(validStatus)).toEqual(validStatus);
  });

  test("AbuseThresholdConfigSchema parses a valid config", () => {
    expect(AbuseThresholdConfigSchema.parse(validThresholds)).toEqual(validThresholds);
  });

  test("AbuseCountersSchema accepts null errorRatePct (warmup)", () => {
    const noRate = { ...validCounters, errorRatePct: null };
    expect(AbuseCountersSchema.parse(noRate)).toEqual(noRate);
  });

  test("AbuseInstanceSchema parses with null endedAt (open instance)", () => {
    expect(AbuseInstanceSchema.parse(validInstance)).toEqual(validInstance);
  });

  test("AbuseDetailSchema parses a full detail payload", () => {
    expect(AbuseDetailSchema.parse(validDetail)).toEqual(validDetail);
  });
});

// ---------------------------------------------------------------------------
// Enum tightening — strict rejection of drifted values
//
// The shared schemas use `z.enum(TUPLE)` without fallback. An unknown
// level/trigger fails parse loudly — that is the intended behavior. The
// real hardening gap is the DB: `abuse_events.level` / `trigger_type` are
// unconstrained `TEXT` with no CHECK constraint and server code hydrates
// via `as AbuseLevel` casts. #1653 tracks the long-term fix (DB
// constraint + server-side coercion with logging). The route layer relies
// on the strict shape for OpenAPI spec fidelity; the web layer surfaces
// parse failures as `schema_mismatch` banners via `useAdminFetch`.
// ---------------------------------------------------------------------------

describe("enum strict rejection", () => {
  test("unknown level fails parse", () => {
    const drifted = { ...validEvent, level: "nuclear" };
    expect(AbuseEventSchema.safeParse(drifted).success).toBe(false);
  });

  test("unknown trigger fails parse in non-nullable position", () => {
    const drifted = { ...validEvent, trigger: "launched_missiles" };
    expect(AbuseEventSchema.safeParse(drifted).success).toBe(false);
  });

  test("nullable trigger permits explicit null", () => {
    const nullTrigger = { ...validStatus, trigger: null };
    const parsed = AbuseStatusSchema.parse(nullTrigger);
    expect(parsed.trigger).toBeNull();
  });

  test("status with drifted level fails parse", () => {
    const drifted = { ...validStatus, level: "melting", events: [] };
    expect(AbuseStatusSchema.safeParse(drifted).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structural validation — proves schemas still reject genuinely broken shapes
// ---------------------------------------------------------------------------

describe("structural rejection", () => {
  test("AbuseEventSchema rejects missing id", () => {
    const { id: _id, ...missing } = validEvent;
    expect(AbuseEventSchema.safeParse(missing).success).toBe(false);
  });

  test("AbuseStatusSchema rejects wrong events type", () => {
    const bad = { ...validStatus, events: "not an array" };
    expect(AbuseStatusSchema.safeParse(bad).success).toBe(false);
  });

  test("AbuseDetailSchema rejects missing counters", () => {
    const { counters: _counters, ...missing } = validDetail;
    expect(AbuseDetailSchema.safeParse(missing).success).toBe(false);
  });

  test("AbuseDetailSchema enforces identity fields from AbuseStatus shape", () => {
    // workspaceId is required on AbuseStatus; omitting it must fail parse.
    const { workspaceId: _workspaceId, ...missing } = validDetail;
    expect(AbuseDetailSchema.safeParse(missing).success).toBe(false);
  });
});
