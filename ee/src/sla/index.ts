/**
 * SLA monitoring and alerting — enterprise feature.
 *
 * Exports:
 * - recordQueryMetric() — fire-and-forget, called from the query path
 * - getAllWorkspaceSLA() / getWorkspaceSLADetail() — read endpoints
 * - getAlerts() / acknowledgeAlert() / evaluateAlerts() — alerting
 * - getThresholds() / updateThresholds() — configuration
 */

export { recordQueryMetric, getAllWorkspaceSLA, getWorkspaceSLADetail } from "./metrics";
export { getThresholds, updateThresholds, getAlerts, acknowledgeAlert, evaluateAlerts } from "./alerting";
