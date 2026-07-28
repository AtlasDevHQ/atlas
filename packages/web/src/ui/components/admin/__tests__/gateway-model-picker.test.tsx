import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import type { GatewayCatalogModel } from "@/ui/lib/types";

import { GatewayModelPicker, isSelectable } from "../gateway-model-picker";

/**
 * #4869 — the picker went from three hardcoded Anthropic options to the live
 * Vercel AI Gateway catalog (~300 entries, of which only ~190 can actually run
 * Atlas's agent loop). `isSelectable` is the entire guard against a workspace
 * pinning its agent to something that can't answer a question — an embedding
 * model, a text-to-speech model, or a chat-only model with no tool calling.
 *
 * The predicate is asserted directly rather than through the rendered combobox:
 * the list lives inside a Radix Popover that only mounts its content once
 * opened, and driving that in jsdom would test Radix, not this rule.
 */

function model(overrides: Partial<GatewayCatalogModel> = {}): GatewayCatalogModel {
  return {
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic",
    type: "language",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    inputPrice: "0.000003",
    outputPrice: "0.000015",
    recommended: false,
    supportsTools: true,
    ...overrides,
  };
}

describe("isSelectable", () => {
  test("accepts a language model that can call tools", () => {
    expect(isSelectable(model())).toBe(true);
  });

  test("rejects every non-language model type the gateway serves", () => {
    // The gateway publishes all of these alongside chat models. Each one would
    // produce a completely broken agent if a workspace could select it.
    for (const type of [
      "embedding",
      "image",
      "video",
      "reranking",
      "transcription",
      "realtime",
      "speech",
    ] as const) {
      expect(isSelectable(model({ type, id: `x/${type}` }))).toBe(false);
    }
  });

  test("rejects a language model that cannot call tools", () => {
    // Atlas is tool-driven — SQL execution, semantic layer, knowledge search.
    // A chat-only model yields an agent that can talk but never answer.
    expect(isSelectable(model({ id: "perplexity/sonar", supportsTools: false }))).toBe(false);
  });

  test("rejects an unknown-typed model (fail-closed, #4869 review)", () => {
    // The normalizer maps a type it doesn't recognize to `other`, NOT to
    // `language`. Before that change it mapped to `language` — the one value
    // that passes this gate — so a type the gateway adds tomorrow would be
    // offered as a selectable chat model with `supportsTools: null`.
    expect(isSelectable(model({ type: "other", id: "x/future", supportsTools: null }))).toBe(false);
  });

  test("ACCEPTS a model whose tool support is unknown", () => {
    // `null` means "the catalog didn't say", not "no". The BYOT direct-provider
    // catalogs (Anthropic/OpenAI/Bedrock /v1/models) publish no capability data
    // at all, so treating null as false would empty those pickers entirely.
    expect(isSelectable(model({ supportsTools: null }))).toBe(true);
  });
});

describe("GatewayModelPicker — unusable saved selection", () => {
  const noop = () => {};

  test("warns when the configured model cannot call tools", () => {
    // Reachable today: a workspace could have saved anything through the API
    // before this filter existed. Hiding it from the list while leaving it
    // configured would be the worst of both worlds — the row would look fine.
    const { baseElement } = render(
      <GatewayModelPicker
        models={[model({ id: "perplexity/sonar", name: "Sonar", supportsTools: false })]}
        value="perplexity/sonar"
        onChange={noop}
      />,
    );
    expect(baseElement.textContent).toContain("can't call tools");
    expect(baseElement.textContent).toContain("perplexity/sonar");
  });

  test("stays quiet for a healthy selection", () => {
    const { baseElement } = render(
      <GatewayModelPicker models={[model()]} value="anthropic/claude-sonnet-5" onChange={noop} />,
    );
    expect(baseElement.textContent).not.toContain("can't call tools");
  });

  test("flags a saved model the live catalog no longer carries (#4869 review)", () => {
    // #4870 removed the version roll-forward that used to remap a retired
    // version onto the current flagship. That was right — relabelling a
    // configured 4.7 as "4.8" is a lie — but it left NO signal, so the row
    // showed a raw ID while every turn failed at the gateway.
    const { baseElement } = render(
      <GatewayModelPicker models={[model()]} value="anthropic/claude-opus-4.1" onChange={noop} />,
    );
    expect(baseElement.textContent).toContain("isn't in the gateway catalog");
  });

  test("does NOT flag a missing model while the catalog is still loading", () => {
    const { baseElement } = render(
      <GatewayModelPicker models={[]} value="anthropic/claude-opus-4.1" onChange={noop} loading />,
    );
    expect(baseElement.textContent).not.toContain("isn't in the gateway catalog");
  });

  test("does NOT flag a missing model against the bundled fallback subset", () => {
    // The fallback is a handful of models; absence from it says nothing about
    // whether the gateway still serves the configured id.
    const { baseElement } = render(
      <GatewayModelPicker
        models={[model()]}
        value="anthropic/claude-opus-4.1"
        onChange={noop}
        fallback
      />,
    );
    expect(baseElement.textContent).not.toContain("isn't in the gateway catalog");
  });

  test("does NOT flag a missing model when the catalog fetch failed outright", () => {
    const { baseElement } = render(
      <GatewayModelPicker models={[]} value="anthropic/claude-opus-4.1" onChange={noop} failed />,
    );
    expect(baseElement.textContent).not.toContain("isn't in the gateway catalog");
    // ...it says the real thing instead.
    expect(baseElement.textContent).toContain("Couldn't load the model catalog");
  });

  test("renders a saved model the catalog no longer carries without inventing a name", () => {
    // A retired version a workspace is still pinned to: the trigger shows the
    // raw ID rather than a friendly label, and no false capability warning
    // fires (we know nothing about a model that isn't in the catalog).
    const { baseElement } = render(
      <GatewayModelPicker models={[model()]} value="anthropic/claude-opus-4.1" onChange={noop} />,
    );
    expect(baseElement.textContent).toContain("anthropic/claude-opus-4.1");
    expect(baseElement.textContent).not.toContain("can't call tools");
  });
});
