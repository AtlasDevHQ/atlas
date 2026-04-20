import { describe, expect, test } from "bun:test";
import {
  SLAAlertSchema,
  SLAAlertsResponseSchema,
  SLAMetricPointSchema,
  SLAThresholdsSchema,
  SLAWorkspacesResponseSchema,
  WorkspaceSLADetailSchema,
  WorkspaceSLASummarySchema,
} from "../sla";
import { SLA_ALERT_STATUSES, SLA_ALERT_TYPES } from "@useatlas/types";

const validSummary = {
  workspaceId: "org_1",
  workspaceName: "Acme",
  latencyP50Ms: 50,
  latencyP95Ms: 120,
  latencyP99Ms: 250,
  errorRatePct: 1.5,
  uptimePct: 99.5,
  totalQueries: 1000,
  failedQueries: 15,
  lastQueryAt: "2026-04-20T12:00:00.000Z",
};

const validMetricPoint = {
  timestamp: "2026-04-20T12:00:00.000Z",
  value: 42,
};

const validAlert = {
  id: "alert_1",
  workspaceId: "org_1",
  workspaceName: "Acme",
  type: "latency_p99" as const,
  status: "firing" as const,
  currentValue: 6000,
  threshold: 5000,
  message: "P99 latency exceeded",
  firedAt: "2026-04-20T12:00:00.000Z",
  resolvedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
};

const validThresholds = {
  latencyP99Ms: 5000,
  errorRatePct: 5,
};

describe("happy-path parses", () => {
  test("WorkspaceSLASummarySchema parses a summary + brands percentages", () => {
    const parsed = WorkspaceSLASummarySchema.parse(validSummary);
    expect(parsed.workspaceId).toBe("org_1");
    // errorRatePct and uptimePct are transformed to Percentage brand; structural equality still holds
    expect(parsed.errorRatePct).toBe(1.5 as typeof parsed.errorRatePct);
    expect(parsed.uptimePct).toBe(99.5 as typeof parsed.uptimePct);
  });

  test("SLAMetricPointSchema parses a timeline point", () => {
    expect(SLAMetricPointSchema.parse(validMetricPoint)).toEqual(validMetricPoint);
  });

  test("WorkspaceSLADetailSchema parses a detail block", () => {
    const detail = {
      summary: validSummary,
      latencyTimeline: [validMetricPoint],
      errorTimeline: [validMetricPoint],
    };
    const parsed = WorkspaceSLADetailSchema.parse(detail);
    expect(parsed.latencyTimeline).toHaveLength(1);
    expect(parsed.errorTimeline).toHaveLength(1);
  });

  test("SLAAlertSchema parses a firing alert", () => {
    expect(SLAAlertSchema.parse(validAlert)).toEqual(validAlert);
  });

  test("SLAThresholdsSchema parses thresholds + brands percentage", () => {
    const parsed = SLAThresholdsSchema.parse(validThresholds);
    expect(parsed.latencyP99Ms).toBe(5000);
  });
});

describe("enum strict rejection", () => {
  test("SLAAlertSchema rejects unknown alert type", () => {
    const drifted = { ...validAlert, type: "cpu_spike" };
    expect(() => SLAAlertSchema.parse(drifted)).toThrow();
  });

  test("SLAAlertSchema rejects unknown alert status", () => {
    const drifted = { ...validAlert, status: "snoozed" };
    expect(() => SLAAlertSchema.parse(drifted)).toThrow();
  });

  test("all SLA_ALERT_STATUSES values parse", () => {
    for (const status of SLA_ALERT_STATUSES) {
      expect(() => SLAAlertSchema.parse({ ...validAlert, status })).not.toThrow();
    }
  });

  test("all SLA_ALERT_TYPES values parse", () => {
    for (const type of SLA_ALERT_TYPES) {
      expect(() => SLAAlertSchema.parse({ ...validAlert, type })).not.toThrow();
    }
  });
});

describe("percentage range rejection", () => {
  test("WorkspaceSLASummarySchema rejects negative errorRatePct", () => {
    expect(() => WorkspaceSLASummarySchema.parse({ ...validSummary, errorRatePct: -1 })).toThrow();
  });

  test("WorkspaceSLASummarySchema rejects errorRatePct > 100 (scale mixup)", () => {
    expect(() => WorkspaceSLASummarySchema.parse({ ...validSummary, errorRatePct: 150 })).toThrow();
  });

  test("SLAThresholdsSchema rejects errorRatePct > 100", () => {
    expect(() => SLAThresholdsSchema.parse({ ...validThresholds, errorRatePct: 200 })).toThrow();
  });
});

describe("timestamp strictness", () => {
  test("SLAAlertSchema rejects non-ISO firedAt", () => {
    const drifted = { ...validAlert, firedAt: "banana" };
    expect(() => SLAAlertSchema.parse(drifted)).toThrow();
  });

  test("WorkspaceSLASummarySchema accepts null lastQueryAt", () => {
    expect(() => WorkspaceSLASummarySchema.parse({ ...validSummary, lastQueryAt: null })).not.toThrow();
  });
});

describe("composite responses", () => {
  test("SLAWorkspacesResponseSchema parses a list", () => {
    const response = { workspaces: [validSummary], hoursBack: 24 };
    const parsed = SLAWorkspacesResponseSchema.parse(response);
    expect(parsed.workspaces).toHaveLength(1);
    expect(parsed.hoursBack).toBe(24);
  });

  test("SLAWorkspacesResponseSchema parses empty workspaces (new deploy / EE-disabled path)", () => {
    const response = { workspaces: [], hoursBack: 24 };
    const parsed = SLAWorkspacesResponseSchema.parse(response);
    expect(parsed.workspaces).toEqual([]);
    expect(parsed.hoursBack).toBe(24);
  });

  test("SLAAlertsResponseSchema parses an alerts list", () => {
    const response = { alerts: [validAlert] };
    const parsed = SLAAlertsResponseSchema.parse(response);
    expect(parsed.alerts).toHaveLength(1);
  });
});
