/**
 * #4779 regression lock: the live-agent `custom` / `azure-openai` `baseUrl` path
 * must egress through the DNS-aware SSRF guard, not the AI SDK's own fetch.
 *
 * `getModelFromWorkspaceConfig` wires `fetch: createGuardedFetch()` into
 * `createOpenAI` for those two providers. That single line is what makes the
 * fix engage on the real inference path — a refactor that dropped it would
 * silently reopen SSRF-to-metadata with every other unit test still green. We
 * mock `@ai-sdk/openai` to capture the `fetch` option handed to `createOpenAI`,
 * then drive it with a literal internal IP: the guard's synchronous first pass
 * rejects it (no DNS needed), proving the installed fetch is the guard.
 */

import { describe, expect, it, mock } from "bun:test";
import { EgressBlockedError } from "../openapi/egress-guard";

// Capture the `fetch` option createOpenAI is constructed with. The returned
// provider is a callable that yields a minimal model stub.
let capturedFetch: typeof globalThis.fetch | undefined;
void mock.module("@ai-sdk/openai", () => ({
  createOpenAI: (opts: { fetch?: typeof globalThis.fetch }) => {
    capturedFetch = opts.fetch;
    return (modelId: string) => ({ modelId, provider: "custom" });
  },
  openai: (modelId: string) => ({ modelId }),
}));

const { getModelFromWorkspaceConfig } = await import("../providers");

describe("getModelFromWorkspaceConfig — live-agent egress guard (#4779)", () => {
  it("installs the DNS-aware guarded fetch on the custom-provider client", async () => {
    capturedFetch = undefined;
    const model = getModelFromWorkspaceConfig({
      model: "custom-llm",
      baseUrl: "https://api.example.com/v1", // public → passes the build-time sync pre-check
      bedrockRegion: null,
      credentials: { provider: "custom", apiKey: "sk-test" },
    });
    expect(typeof model).toBe("object");

    // The client was built with a `fetch` override…
    expect(typeof capturedFetch).toBe("function");
    // …and that override is the SSRF guard: a literal internal IP is rejected by
    // its synchronous first pass, before any connect (no DNS round-trip).
    await expect(
      capturedFetch!("https://169.254.169.254/v1/chat/completions", { method: "POST" }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });
});
