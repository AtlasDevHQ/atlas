/**
 * Digest generation — runs metric queries and aggregates results.
 *
 * Failures are isolated per metric: if one metric fails, the digest
 * still includes the remaining successful metrics with an error
 * placeholder for the failed one.
 */

import type { EmailDigestPluginConfig, MetricResult } from "./config";
import type { PluginLogger } from "@useatlas/plugin-sdk";

export interface DigestSubscription {
  id: string;
  userId: string;
  email: string;
  metrics: string[];
  frequency: "daily" | "weekly";
  deliveryHour: number;
  timezone: string;
  enabled: boolean;
}

export interface DigestPayload {
  subscription: DigestSubscription;
  metrics: MetricResult[];
  generatedAt: string;
}

/**
 * Generate a digest for a single subscription.
 * Runs each metric query independently — partial failures produce
 * error placeholders, not a full digest failure.
 */
export async function generateDigest(
  subscription: DigestSubscription,
  executeMetric: EmailDigestPluginConfig["executeMetric"],
  log?: Pick<PluginLogger, "warn">,
): Promise<DigestPayload> {
  const results = await Promise.all(
    subscription.metrics.map(async (metricName): Promise<MetricResult> => {
      try {
        return await executeMetric(metricName);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log?.warn(
          { subscriptionId: subscription.id, metric: metricName, err: message },
          "Metric execution failed — digest will include error placeholder",
        );
        return {
          name: metricName,
          value: null,
          error: message,
        };
      }
    }),
  );

  return {
    subscription,
    metrics: results,
    generatedAt: new Date().toISOString(),
  };
}
