/**
 * SLA monitoring and alerting — enterprise feature.
 *
 * Exports:
 * - recordQueryMetric() — fire-and-forget, called from executeAndAudit() in sql.ts
 * - getAllWorkspaceSLA() / getWorkspaceSLADetail() — read endpoints
 * - getAlerts() / acknowledgeAlert() / evaluateAlerts() — alerting
 * - getThresholds() / updateThresholds() — configuration
 *
 * Post-#2568 (slice 6/11 of #2017): these functions are also exposed
 * through the `SlaMetrics` Tag via `SlaMetricsLive` aggregated into
 * `ee/src/layers.ts:EELayer`. Core call sites
 * (`lib/tools/sql.ts`, `api/routes/platform-sla.ts`) reach the
 * implementation through the Tag, not through direct imports.
 */

import { Layer } from "effect";
import {
  SlaMetrics,
  type SlaMetricsShape,
} from "@atlas/api/lib/effect/services";
import {
  recordQueryMetric,
  getAllWorkspaceSLA,
  getWorkspaceSLADetail,
} from "./metrics";
import {
  getThresholds,
  updateThresholds,
  getAlerts,
  acknowledgeAlert,
  evaluateAlerts,
} from "./alerting";

export { recordQueryMetric, getAllWorkspaceSLA, getWorkspaceSLADetail } from "./metrics";
export { getThresholds, updateThresholds, getAlerts, acknowledgeAlert, evaluateAlerts } from "./alerting";

export const makeSlaMetricsLive = (): SlaMetricsShape => ({
  available: true,
  recordQueryMetric,
  getAllWorkspaceSLA,
  getWorkspaceSLADetail,
  getThresholds,
  updateThresholds,
  getAlerts,
  acknowledgeAlert,
  evaluateAlerts,
});

export const SlaMetricsLive: Layer.Layer<SlaMetrics> = Layer.sync(
  SlaMetrics,
  makeSlaMetricsLive,
);
