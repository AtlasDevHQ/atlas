/**
 * Widget empty-state starter-prompts behavior — issue #1479.
 *
 * Two paths:
 *
 *  1. No `starterPrompts` prop → widget calls `/api/v1/starter-prompts` and
 *     renders the returned list with provenance badges.
 *  2. `starterPrompts` prop supplied → widget MUST NOT call the endpoint
 *     (verified via fetch interception) and renders the supplied strings as
 *     a flat list with no provenance badge.
 *
 * The "no network call" assertion is the correctness guarantee of the slice
 * — overrides exist precisely so plugin authors can avoid leaking a
 * user-identifying request from embedded contexts.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import { AtlasChat } from "../atlas-chat";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

const capturedRequests: CapturedRequest[] = [];

function defaultFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  capturedRequests.push({ url, init: init ?? {} });

  if (url.includes("/api/health")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({ checks: { auth: { mode: "simple-key" } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
  if (url.includes("/api/v1/starter-prompts")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          prompts: [
            { id: "favorite:1", text: "My pinned question", provenance: "favorite" },
            { id: "popular:2", text: "Top accounts by revenue", provenance: "popular" },
            { id: "library:3", text: "Cybersecurity threat trends", provenance: "library" },
          ],
          total: 3,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
  if (url.includes("/api/v1/branding")) {
    return Promise.resolve(
      new Response(JSON.stringify({ branding: { hideAtlasBranding: false } }), { status: 200 }),
    );
  }
  // Default: 404 — the widget tolerates this for non-essential endpoints.
  return Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
}

const fetchMock = mock(defaultFetch);
const originalFetch = globalThis.fetch;

beforeEach(() => {
  capturedRequests.length = 0;
  fetchMock.mockImplementation(defaultFetch);
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("AtlasChat empty state — starter prompts", () => {
  it("fetches /api/v1/starter-prompts when no override prop is supplied", async () => {
    const { findByText } = render(
      <AtlasChat apiUrl="https://api.example.com" apiKey="test-key" />,
    );

    // Each fetched prompt should render in the empty-state grid.
    await findByText("My pinned question", undefined, { timeout: 5_000 });
    await findByText("Top accounts by revenue");
    await findByText("Cybersecurity threat trends");

    const starterReq = capturedRequests.find((r) => r.url.includes("/api/v1/starter-prompts"));
    expect(starterReq).toBeDefined();
    // The bearer token must propagate so the resolver returns the
    // current user's favorites tier.
    const headers = starterReq!.init.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("Bearer test-key");
  });

  it("renders provenance badges matching the web app's pin marker for favorites", async () => {
    const { findAllByTestId, queryByTestId } = render(
      <AtlasChat apiUrl="https://api.example.com" />,
    );

    const favoriteRows = await findAllByTestId("starter-prompt-favorite", undefined, { timeout: 5_000 });
    expect(favoriteRows.length).toBe(1);
    expect(favoriteRows[0].textContent ?? "").toContain("My pinned question");

    // Popular and library rows render the same prompt button without the pin icon.
    expect(queryByTestId("starter-prompt-popular")?.textContent ?? "").toContain("Top accounts by revenue");
    expect(queryByTestId("starter-prompt-library")?.textContent ?? "").toContain("Cybersecurity threat trends");
  });

  it("does NOT call /api/v1/starter-prompts when the prop override is supplied", async () => {
    const overrides = ["Static prompt one", "Static prompt two"];
    const { findByText } = render(
      <AtlasChat
        apiUrl="https://api.example.com"
        apiKey="test-key"
        starterPrompts={overrides}
      />,
    );

    await findByText("Static prompt one", undefined, { timeout: 5_000 });
    await findByText("Static prompt two");

    // Health is still fetched; assert ONLY that the starter-prompts endpoint
    // was never hit. This is the privacy-correctness guarantee for the
    // override path (issue #1479).
    await waitFor(() => {
      expect(capturedRequests.find((r) => r.url.includes("/api/health"))).toBeDefined();
    });
    const starterReq = capturedRequests.find((r) => r.url.includes("/api/v1/starter-prompts"));
    expect(starterReq).toBeUndefined();
  });

  it("override list renders without provenance badges (flat list)", async () => {
    const overrides = ["Static prompt one", "Static prompt two"];
    const { findAllByTestId, queryAllByTestId } = render(
      <AtlasChat apiUrl="https://api.example.com" starterPrompts={overrides} />,
    );

    // Override prompts are tagged "library" provenance internally to reuse
    // the renderer, but they MUST NOT render the favorite pin marker.
    const libraryRows = await findAllByTestId("starter-prompt-library", undefined, { timeout: 5_000 });
    expect(libraryRows.length).toBe(2);
    expect(queryAllByTestId("starter-prompt-favorite")).toHaveLength(0);
  });

  it("override drops empty / non-string entries safely", async () => {
    // Mixed array with an empty string and whitespace — both should be
    // dropped before render rather than producing empty buttons.
    const overrides = ["Valid prompt", "", "   "];
    const { findAllByTestId } = render(
      <AtlasChat apiUrl="https://api.example.com" starterPrompts={overrides} />,
    );

    const rows = await findAllByTestId("starter-prompt-library", undefined, { timeout: 5_000 });
    expect(rows.length).toBe(1);
    expect(rows[0].textContent ?? "").toContain("Valid prompt");
  });

  it("empty override array still suppresses the network call (zero-prompt embed)", async () => {
    render(
      <AtlasChat apiUrl="https://api.example.com" starterPrompts={[]} />,
    );

    // Wait for health to settle before asserting absence of starter call.
    await waitFor(() => {
      expect(capturedRequests.find((r) => r.url.includes("/api/health"))).toBeDefined();
    });
    const starterReq = capturedRequests.find((r) => r.url.includes("/api/v1/starter-prompts"));
    expect(starterReq).toBeUndefined();
  });
});
