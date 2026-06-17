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
import { OPERATOR_PLATFORMS } from "../platforms";

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
