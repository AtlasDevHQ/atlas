/**
 * Shared `@atlas/api/lib/providers` mock fragment for the `startup.test.ts`
 * family (#3200).
 *
 * `startup.ts` mocks the whole `providers` module to keep the heavy `@ai-sdk/*`
 * static imports out of the diagnostics tests. Once `checkProviderApiKey` moved
 * to the set-based `getMissingProviderConfig` SSOT, every one of those mocks
 * needs a faithful stand-in for it (and `isSupportedProvider`). Centralising the
 * stand-in here keeps the four mock blocks from each hand-copying — and silently
 * drifting from — the real provider-config semantics (Bedrock all-or-none,
 * openai-compatible base URL). Mirror of `lib/providers.ts`; not a test itself
 * (plain `.ts`, so the isolated runner skips it).
 */

const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai",
  "bedrock",
  "ollama",
  "openai-compatible",
  "gateway",
] as const;

export function mockIsSupportedProvider(value: string): boolean {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

function isEnvSet(key: string): boolean {
  const value = process.env[key];
  return value !== undefined && value !== "";
}

/** Mirror of `providers.ts:getMissingProviderConfig` (#3200). */
export function mockGetMissingProviderConfig(provider: string): string[] {
  switch (provider) {
    case "anthropic":
      return isEnvSet("ANTHROPIC_API_KEY") ? [] : ["ANTHROPIC_API_KEY"];
    case "openai":
      return isEnvSet("OPENAI_API_KEY") ? [] : ["OPENAI_API_KEY"];
    case "gateway":
      return isEnvSet("AI_GATEWAY_API_KEY") ? [] : ["AI_GATEWAY_API_KEY"];
    case "openai-compatible": {
      const missing: string[] = [];
      if (!isEnvSet("OPENAI_COMPATIBLE_BASE_URL")) missing.push("OPENAI_COMPATIBLE_BASE_URL");
      if (!isEnvSet("ATLAS_MODEL")) missing.push("ATLAS_MODEL");
      return missing;
    }
    case "bedrock": {
      const pair = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
      if (!pair.some(isEnvSet)) return []; // credential-provider chain
      return pair.filter((key) => !isEnvSet(key));
    }
    case "ollama":
      return [];
    default:
      return [];
  }
}
