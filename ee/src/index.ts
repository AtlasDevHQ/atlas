/**
 * Atlas Enterprise — gated features under a commercial license.
 *
 * Exports allow any package to check or enforce the enterprise gate:
 *
 *   isEnterpriseEnabled()       — returns boolean (safe for conditional logic)
 *   getEnterpriseLicenseKey()   — returns the license key string, if set
 *   requireEnterprise()         — throws if not enabled or no license key (guard)
 */

import { getConfig } from "@atlas/api/lib/config";

/**
 * Check whether enterprise features are enabled via config or env var.
 *
 * Resolution order:
 * 1. `enterprise.enabled` in atlas.config.ts (if enterprise section is configured)
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
 * Typed error thrown when enterprise features are required but not available.
 * Use `err instanceof EnterpriseError` instead of string matching on messages.
 */
export class EnterpriseError extends Error {
  readonly code = "enterprise_required" as const;
  constructor(message = "Enterprise features are not enabled") {
    super(message);
    this.name = "EnterpriseError";
  }
}

/**
 * Guard: throws if enterprise is not enabled or no license key is configured.
 * Use at the entry point of any enterprise-only code path.
 */
export function requireEnterprise(feature?: string): void {
  const label = feature ? ` (${feature})` : "";
  if (!isEnterpriseEnabled()) {
    throw new EnterpriseError(
      `Enterprise features${label} are not enabled. ` +
      `Set ATLAS_ENTERPRISE_ENABLED=true and provide a license key, ` +
      `or configure enterprise.enabled in atlas.config.ts. ` +
      `Visit https://useatlas.dev/enterprise for licensing options.`,
    );
  }
  const key = getEnterpriseLicenseKey();
  if (!key) {
    throw new EnterpriseError(
      `Enterprise features${label} are enabled but no license key is configured. ` +
      `Set ATLAS_ENTERPRISE_LICENSE_KEY or configure enterprise.licenseKey in atlas.config.ts. ` +
      `Visit https://useatlas.dev/enterprise for licensing options.`,
    );
  }
}
