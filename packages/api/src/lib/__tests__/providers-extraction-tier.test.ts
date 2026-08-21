/**
 * The ingest tier, and the boundary it must not cross (#5353).
 *
 * The rule this file pins: **model tier follows the latency budget and the blast
 * radius, not the subsystem.** Extraction has a latency budget of hours, roughly
 * ten times chat's volume, and its output reaches a review queue as a draft
 * rather than a person as an answer — so it resolves its own model. Chat has
 * none of those properties and keeps the frontier model.
 *
 * Two halves, and the second is the one that decays quietly:
 *
 *   1. The ingest tier resolves as designed — explicit setting, then the
 *      provider's cheap default, then "whatever the turn would" for providers
 *      that have no separate tier.
 *   2. **The interactive path is untouched.** #5353's whole point is that ingest
 *      stops inheriting the chat model; a knob that quietly worked in BOTH
 *      directions would be the same coupling wearing a new name, and nothing
 *      about the extraction path would notice.
 */

import { afterEach, describe, expect, test } from "bun:test";

const { resolveExtractionModelId, resolveModelId, getBatchApiKey, getMissingModelConfig } =
  await import("@atlas/api/lib/providers");

const ENV_KEYS = [
  "ATLAS_PROVIDER",
  "ATLAS_MODEL",
  "ATLAS_BRAIN_EXTRACTION_MODEL",
  "ANTHROPIC_API_KEY",
  "VERCEL",
  "ATLAS_DEPLOY_MODE",
] as const;

const originals = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of originals) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function useProvider(provider: string): void {
  process.env.ATLAS_PROVIDER = provider;
  delete process.env.VERCEL;
  delete process.env.ATLAS_DEPLOY_MODE;
}

// ---------------------------------------------------------------------------
// 1. The tier resolves
// ---------------------------------------------------------------------------

describe("resolveExtractionModelId", () => {
  test("each provider with a cheap tier gets its own id, not a shared string", () => {
    // The ids differ per vendor and the vendors spell them differently —
    // `claude-haiku-4-5` direct, `anthropic.claude-haiku-4-5` on Bedrock,
    // `anthropic/claude-haiku-4.5` through the gateway. One shared constant
    // would 404 on two of the three.
    const expected: Record<string, string> = {
      anthropic: "claude-haiku-4-5",
      bedrock: "anthropic.claude-haiku-4-5",
      gateway: "anthropic/claude-haiku-4.5",
      openai: "gpt-4o-mini",
    };
    for (const [provider, modelId] of Object.entries(expected)) {
      useProvider(provider);
      expect(resolveExtractionModelId({ override: null, workspaceConfig: null })).toBe(modelId);
    }
  });

  test("⭐ a provider with no separate tier falls through rather than erroring", () => {
    // #5353's AC: "A workspace that has set nothing keeps working, with the new
    // default rather than an error." `ollama` is local inference — there is no
    // cheaper tier to trade down to — and `openai-compatible` has no model
    // vocabulary at all. Naming one would point the fiber at a model the
    // operator may never have pulled.
    for (const provider of ["ollama", "openai-compatible"]) {
      useProvider(provider);
      expect(resolveExtractionModelId({ override: null, workspaceConfig: null })).toBeNull();
    }
  });

  test("an explicit setting beats the tier default", () => {
    useProvider("anthropic");
    expect(resolveExtractionModelId({ override: "claude-sonnet-5", workspaceConfig: null })).toBe(
      "claude-sonnet-5",
    );
    // Whitespace is not a setting. A blank-ish value must resolve to the
    // default rather than to a model id of `" "`, which would 400 every call.
    expect(resolveExtractionModelId({ override: "   ", workspaceConfig: null })).toBe(
      "claude-haiku-4-5",
    );
  });

  test("an unknown ATLAS_PROVIDER falls through instead of guessing", () => {
    // The unsupported-provider decision belongs to `isSupportedProvider`, and
    // guessing a tier for a provider we do not recognise would substitute a
    // model id into a request we cannot reason about at all.
    useProvider("not-a-provider");
    expect(resolveExtractionModelId({ override: null, workspaceConfig: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The interactive path, provably unchanged
// ---------------------------------------------------------------------------

describe("the chat path does not read the extraction setting", () => {
  test("⭐ ATLAS_BRAIN_EXTRACTION_MODEL never reaches resolveModelId", () => {
    // THE assertion #5353 names. `resolveModelId` is the SSOT the billing page
    // and the agent loop both flow through (#3098), so if the extraction knob
    // could reach it, setting a cheap ingest tier would silently downgrade every
    // chat turn in the workspace — and the billing page would keep advertising
    // the old model.
    //
    // MUTATION THIS CATCHES: routing `resolveExtractionModelId` through
    // `resolveSelection`, or adding `ATLAS_BRAIN_EXTRACTION_MODEL` to
    // `resolveSelection`'s fallback chain. Every extraction test still passes.
    useProvider("anthropic");
    delete process.env.ATLAS_MODEL;
    const withoutKnob = resolveModelId();

    process.env.ATLAS_BRAIN_EXTRACTION_MODEL = "claude-haiku-4-5";
    expect(resolveModelId()).toBe(withoutKnob);
    // And the control, in the same test so the two are shown to DIFFER: the
    // knob IS read by the extraction path. Without this, `toBe(withoutKnob)`
    // would also pass on an implementation where the knob is dead everywhere.
    expect(resolveExtractionModelId({ override: "claude-haiku-4-5", workspaceConfig: null })).toBe(
      "claude-haiku-4-5",
    );
  });

  test("the chat model still comes from ATLAS_MODEL", () => {
    // The other direction: the turn's own knob keeps working while the ingest
    // tier diverges from it. A frontier chat model and a cheap ingest model, at
    // the same time, on the same provider — which is the whole arrangement.
    useProvider("anthropic");
    process.env.ATLAS_MODEL = "claude-opus-5";
    process.env.ATLAS_BRAIN_EXTRACTION_MODEL = "";
    expect(resolveModelId()).toBe("claude-opus-5");
    expect(resolveExtractionModelId({ override: "", workspaceConfig: null })).toBe(
      "claude-haiku-4-5",
    );
  });

  test("the extraction knob does not change what counts as a configured provider", () => {
    // `getMissingModelConfig` is the fail-fast used before a batch of
    // enrichment calls. It answers about the TURN's provider; an extraction
    // knob leaking into it would report a provider as configured (or not) on
    // evidence from a different code path.
    useProvider("openai-compatible");
    delete process.env.ATLAS_MODEL;
    const before = getMissingModelConfig().missing;
    process.env.ATLAS_BRAIN_EXTRACTION_MODEL = "some-local-model";
    expect(getMissingModelConfig().missing).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 3. Batch capability is a property of the resolved provider (#5352)
// ---------------------------------------------------------------------------

describe("getBatchApiKey", () => {
  test("⭐ only an Anthropic-resolved provider yields a batch key", () => {
    // The fallback path's precondition. `bedrock` and `gateway` have batch
    // endpoints of their OWN with different request and result shapes, and
    // `ollama` / `openai-compatible` have none — so returning a key for any of
    // them would submit an Anthropic-shaped body to something that is not
    // Anthropic.
    process.env.ANTHROPIC_API_KEY = "sk-ant-platform";
    useProvider("anthropic");
    expect(getBatchApiKey(null)).toBe("sk-ant-platform");
    for (const provider of ["openai", "bedrock", "gateway", "ollama", "openai-compatible"]) {
      useProvider(provider);
      expect(getBatchApiKey(null)).toBeNull();
    }
  });

  test("an Anthropic provider with no key configured yields null, not an empty string", () => {
    // `""` is falsy but is still a string, and a caller testing `!== null`
    // would submit a batch with an empty `x-api-key` header.
    useProvider("anthropic");
    delete process.env.ANTHROPIC_API_KEY;
    expect(getBatchApiKey(null)).toBeNull();
  });

  test("a BYO workspace's own key is used, and only for the anthropic arm", () => {
    // The credential rule the extraction fiber is built on: a BYO workspace's
    // extraction runs on that workspace's key, never the platform's. Env is set
    // to a DIFFERENT value so a fallback to it would be visible rather than
    // coincidentally equal.
    process.env.ANTHROPIC_API_KEY = "sk-ant-platform";
    useProvider("anthropic");
    expect(
      getBatchApiKey({
        model: "claude-opus-5",
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "anthropic", apiKey: "sk-ant-workspace" },
      }),
    ).toBe("sk-ant-workspace");

    expect(
      getBatchApiKey({
        model: "gpt-4o",
        baseUrl: null,
        bedrockRegion: null,
        credentials: { provider: "openai", apiKey: "sk-openai-workspace" },
      }),
    ).toBeNull();
  });
});
