/**
 * Widget managed-auth gate.
 *
 * Embedders that supply their own bearer token (the `/demo` flow signs a
 * short-lived JWT and passes it as `apiKey`) must NOT see the managed
 * sign-in card on managed-auth deploys — they've already authenticated
 * upstream and the bearer is attached to every fetch by `useAtlasTransport`.
 *
 * The gate (`packages/react/src/components/atlas-chat.tsx` →
 * `showManagedSignInCard`) carries a three-clause invariant. A regression
 * that drops the `!hasEmbedderApiKey` clause silently breaks every embedded
 * surface — they'd render a Better Auth sign-in form on top of a chat with
 * a perfectly valid token.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import { AtlasChat } from "../atlas-chat";

interface CapturedRequest {
  url: string;
}

const capturedRequests: CapturedRequest[] = [];

function makeFetchMock(authMode: "managed" | "simple-key" | "none") {
  return function fetchImpl(input: string | URL | Request): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    capturedRequests.push({ url });

    if (url.includes("/api/health")) {
      return Promise.resolve(
        new Response(JSON.stringify({ checks: { auth: { mode: authMode } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.includes("/api/v1/branding")) {
      return Promise.resolve(
        new Response(JSON.stringify({ branding: { hideAtlasBranding: false } }), {
          status: 200,
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
    );
  };
}

const fetchMock = mock(makeFetchMock("managed"));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  capturedRequests.length = 0;
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("AtlasChat managed-auth gate", () => {
  it("renders ManagedAuthCard on managed-auth without session and without apiKey", async () => {
    fetchMock.mockImplementation(makeFetchMock("managed"));

    const { findByTestId } = render(<AtlasChat apiUrl="https://api.example.com" />);

    await findByTestId("managed-auth-card", undefined, { timeout: 5_000 });
  });

  it("does NOT render ManagedAuthCard when the embedder supplies apiKey", async () => {
    fetchMock.mockImplementation(makeFetchMock("managed"));

    const { queryByTestId } = render(
      <AtlasChat apiUrl="https://api.example.com" apiKey="demo-jwt" />,
    );

    // Wait for health to resolve so the gate has actually run.
    await waitFor(() => {
      expect(capturedRequests.find((r) => r.url.includes("/api/health"))).toBeDefined();
    });
    // ManagedAuthCard must stay suppressed once authMode is known.
    await waitFor(() => {
      expect(queryByTestId("managed-auth-card")).toBeNull();
    });
  });

  it("does NOT render ManagedAuthCard on simple-key mode regardless of apiKey", async () => {
    fetchMock.mockImplementation(makeFetchMock("simple-key"));

    const { queryByTestId } = render(
      <AtlasChat apiUrl="https://api.example.com" apiKey="demo-jwt" />,
    );

    await waitFor(() => {
      expect(capturedRequests.find((r) => r.url.includes("/api/health"))).toBeDefined();
    });
    expect(queryByTestId("managed-auth-card")).toBeNull();
  });
});
