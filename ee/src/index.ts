/**
 * Atlas Enterprise — gated features under a commercial license.
 *
 * The two main exports allow any package to check or enforce the enterprise
 * gate at runtime:
 *
 *   isEnterpriseEnabled()  — returns boolean (safe for conditional logic)
 *   requireEnterprise()    — throws if enterprise is not enabled (guard)
 */

import { getConfig } from "@atlas/api/lib/config";

/**
 * Check whether enterprise features are enabled via config or env var.
 *
 * Resolution order:
 * 1. `enterprise.enabled` in atlas.config.ts (if config file is loaded)
 * 2. `ATLAS_ENTERPRISE_ENABLED` env var
 */
export function isEnterpriseEnabled(): boolean {
  const config = getConfig();
  if (config?.enterprise?.enabled !== undefined) {
    return config.enterprise.enabled;
  }
  return process.env.ATLAS_ENTERPRISE_ENABLED === "true";
}

/**
 * Return the enterprise license key, if configured.
 *
 * Resolution order:
 * 1. `enterprise.licenseKey` in atlas.config.ts
 * 2. `ATLAS_ENTERPRISE_LICENSE_KEY` env var
 */
export function getEnterpriseLicenseKey(): string | undefined {
  const config = getConfig();
  return config?.enterprise?.licenseKey ?? process.env.ATLAS_ENTERPRISE_LICENSE_KEY ?? undefined;
}

/**
 * Guard: throws if enterprise is not enabled.
 * Use at the entry point of any enterprise-only code path.
 */
export function requireEnterprise(feature?: string): void {
  if (!isEnterpriseEnabled()) {
    const label = feature ? ` (${feature})` : "";
    throw new Error(
      `Enterprise features${label} require a valid license. ` +
      `Set ATLAS_ENTERPRISE_ENABLED=true and provide a license key, ` +
      `or configure enterprise.enabled in atlas.config.ts. ` +
      `Visit https://useatlas.dev/enterprise for licensing options.`,
    );
  }
}
