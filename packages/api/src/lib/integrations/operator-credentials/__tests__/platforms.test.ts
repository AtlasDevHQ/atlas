/**
 * Drift guard for the operator-platform registry (#3704).
 *
 * Each managed operator platform's REQUIRED fields are hand-copied from the
 * adapter builder's `requiredEnv` set in `@useatlas/chat` (a separate
 * package). The copy is what lets the Admin form offer exactly the keys the
 * adapter needs. This test pins the parity against the SSOT accessor
 * (`getChatAdapterRequiredEnv`) so an adapter-side change to `requiredEnv`
 * can't silently drift the registry — the prose claim in `platforms.ts`
 * stays true by construction.
 */

import { describe, expect, it } from "bun:test";
import { getChatAdapterRequiredEnv } from "@useatlas/chat";
import { OPERATOR_PLATFORMS, getOperatorPlatform } from "../platforms";

describe("operator platform ⇄ adapter requiredEnv parity", () => {
  for (const platform of OPERATOR_PLATFORMS) {
    // Only chat platforms map to a chat-adapter builder's requiredEnv.
    if (platform.catalogSlug === null) continue;

    it(`${platform.platform}: required fields mirror getChatAdapterRequiredEnv("${platform.catalogSlug}")`, () => {
      const adapterRequired = getChatAdapterRequiredEnv(platform.catalogSlug!);
      expect(adapterRequired).not.toBeNull();

      const registryRequired = platform.fields
        .filter((f) => f.required)
        .map((f) => f.envVar)
        .sort();

      expect(registryRequired).toEqual([...adapterRequired!].sort());
    });
  }
});

describe("managed operator chat platforms", () => {
  // The full set of chat platforms that ship a `@useatlas/chat` adapter
  // builder and are managed from Admin → Platform Integrations. Pinned
  // explicitly so dropping a registry entry (or forgetting to add one when a
  // new adapter lands) fails loudly here rather than silently shrinking the
  // Admin surface. `catalogSlug === platform` for every chat platform, so the
  // slug doubles as the `getChatAdapterRequiredEnv` key.
  const EXPECTED_CHAT_PLATFORMS = [
    "slack",
    "discord",
    "teams",
    "telegram",
    "whatsapp",
    "gchat",
  ] as const;

  for (const slug of EXPECTED_CHAT_PLATFORMS) {
    it(`registers "${slug}" with a chat catalog slug and adapter-mirrored required fields`, () => {
      const spec = getOperatorPlatform(slug);
      expect(spec).toBeDefined();
      // Chat platforms key their catalog slug to the platform slug.
      expect(spec!.catalogSlug).toBe(slug);

      const adapterRequired = getChatAdapterRequiredEnv(slug);
      expect(adapterRequired).not.toBeNull();

      // Every adapter-required env var has a matching required field, and the
      // field's `envVar` is the storage/env key the adapter reads.
      const requiredFieldVars = spec!.fields
        .filter((f) => f.required)
        .map((f) => f.envVar)
        .sort();
      expect(requiredFieldVars).toEqual([...adapterRequired!].sort());
    });
  }
});

describe("operator platform secret classification", () => {
  // The `secret` flag drives UI masking (and signals which fields carry real
  // credentials vs. public identifiers). Pin the expected secret env vars per
  // platform so a misclassification — e.g. marking a bot token or service-
  // account JSON `secret: false`, or a public app/client ID `secret: true` —
  // fails loudly here. The parity tests above only cover field membership, not
  // this flag. Every env var NOT listed for a platform must be `secret: false`.
  const EXPECTED_SECRET_FIELDS: Record<string, readonly string[]> = {
    slack: ["SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET", "SLACK_ENCRYPTION_KEY"],
    discord: ["DISCORD_BOT_TOKEN"],
    teams: ["TEAMS_APP_PASSWORD"],
    telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
    whatsapp: ["META_BUSINESS_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"],
    gchat: ["GCHAT_SERVICE_ACCOUNT_JSON"],
  };

  for (const platform of OPERATOR_PLATFORMS) {
    const expected = EXPECTED_SECRET_FIELDS[platform.platform];
    // A new platform without a pinned expectation should fail the suite, not
    // be silently skipped — assert we have one for every managed platform.
    it(`pins secret-field expectations for "${platform.platform}"`, () => {
      expect(expected).toBeDefined();
    });

    if (!expected) continue;

    it(`classifies secret fields correctly for "${platform.platform}"`, () => {
      const actualSecretVars = platform.fields
        .filter((f) => f.secret)
        .map((f) => f.envVar)
        .sort();
      expect(actualSecretVars).toEqual([...expected].sort());
    });
  }
});
