/**
 * Widget empty-state loading + cold-start fallback behavior (#3936 §F5).
 *
 * The adaptive starter-prompt list (`/api/v1/starter-prompts`) is generated
 * server-side and can take ~15s on a cold semantic index. A first-time
 * visitor must never face a bare "ask anything" empty state with no
 * suggestions while that resolves — nor when it comes back empty (the
 * server's cold-start signal). This file pins the empty-state contract
 * across every path. The three core guarantees:
 *
 *  1. While the fetch is in flight → skeleton chips render (no bare empty
 *     state, no "ask your first question" dead-end).
 *  2. Adaptive prompts replace the skeleton once they resolve.
 *  3. An empty adaptive response (cold-start) falls back to the shared
 *     static prompt set rather than rendering nothing.
 *
 * Plus the resolution-via-error and override paths: a 5xx soft-fail and a
 * 4xx throw both degrade to the static fallback; the override prop owns its
 * own empty state (no skeleton, no fallback, and an explicit `[]` keeps the
 * dead-end copy rather than injecting suggestions).
 *
 * The `starterPrompts` override path already short-circuits the fetch (see
 * atlas-chat.starter-prompts.test.tsx); it never sees the skeleton/fallback,
 * which this file leaves to that suite.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import { AtlasChat } from "../atlas-chat";
import { DEFAULT_STARTER_PROMPT_TEXTS } from "../../lib/fallback-starter-prompts";

let resolveStarter: ((res: Response) => void) | null = null;

function makeFetch(starterBody: unknown, starterStatus = 200) {
  return function fetchImpl(input: string | URL | Request): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/api/health")) {
      return Promise.resolve(
        new Response(JSON.stringify({ checks: { auth: { mode: "simple-key" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.includes("/api/v1/starter-prompts")) {
      if (starterBody === "pending") {
        // Never resolves on its own — the test drives it via resolveStarter.
        return new Promise<Response>((resolve) => {
          resolveStarter = resolve;
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify(starterBody), {
          status: starterStatus,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.includes("/api/v1/branding")) {
      return Promise.resolve(
        new Response(JSON.stringify({ branding: { hideAtlasBranding: false } }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
  };
}

const fetchMock = mock(makeFetch("pending"));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  resolveStarter = null;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("AtlasChat empty state — loading skeleton + cold-start fallback", () => {
  it("renders skeleton chips while the adaptive list is in flight (no bare empty state)", async () => {
    fetchMock.mockImplementation(makeFetch("pending"));
    const { findAllByTestId, queryByText } = render(
      <AtlasChat apiUrl="https://api.example.com" apiKey="test-key" />,
    );

    const chips = await findAllByTestId("starter-prompt-skeleton", undefined, { timeout: 5_000 });
    expect(chips.length).toBeGreaterThan(0);
    // The dead-end copy must NOT show while we're still loading.
    expect(queryByText("Ask your first question below to get started.")).toBeNull();
  });

  it("replaces the skeleton with adaptive prompts once they resolve", async () => {
    fetchMock.mockImplementation(
      makeFetch({
        prompts: [{ id: "popular:1", text: "Top accounts by revenue", provenance: "popular" }],
        total: 1,
      }),
    );
    const { findByText, queryByTestId } = render(
      <AtlasChat apiUrl="https://api.example.com" apiKey="test-key" />,
    );

    await findByText("Top accounts by revenue", undefined, { timeout: 5_000 });
    // Skeleton is gone once real prompts land.
    expect(queryByTestId("starter-prompt-skeleton")).toBeNull();
  });

  it("falls back to the shared static prompts when the adaptive list resolves empty (cold-start)", async () => {
    fetchMock.mockImplementation(makeFetch({ prompts: [], total: 0 }));
    const { findByText, queryByTestId } = render(
      <AtlasChat apiUrl="https://api.example.com" apiKey="test-key" />,
    );

    // Every shared fallback prompt renders rather than a bare dead-end.
    await findByText(DEFAULT_STARTER_PROMPT_TEXTS[0], undefined, { timeout: 5_000 });
    for (const text of DEFAULT_STARTER_PROMPT_TEXTS.slice(1)) {
      await findByText(text);
    }
    expect(queryByTestId("starter-prompt-skeleton")).toBeNull();
  });

  it("swaps skeleton → adaptive without ever showing the dead-end copy", async () => {
    fetchMock.mockImplementation(makeFetch("pending"));
    const { findAllByTestId, findByText, queryByText } = render(
      <AtlasChat apiUrl="https://api.example.com" apiKey="test-key" />,
    );

    await findAllByTestId("starter-prompt-skeleton", undefined, { timeout: 5_000 });
    expect(queryByText("Ask your first question below to get started.")).toBeNull();

    // Now let the in-flight request resolve with adaptive prompts.
    await waitFor(() => expect(resolveStarter).not.toBeNull());
    resolveStarter!(
      new Response(
        JSON.stringify({
          prompts: [{ id: "library:1", text: "Cybersecurity threat trends", provenance: "library" }],
          total: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await findByText("Cybersecurity threat trends");
    expect(queryByText("Ask your first question below to get started.")).toBeNull();
  });

  it("falls back to static prompts when the adaptive fetch 5xx-soft-fails (transient backend fault)", async () => {
    // The SDK soft-fails a 5xx to an empty list, so the empty-state gate sees
    // the same resolved-empty signal as a cold-start 200 — and must still
    // render the fallback, not a bare dead-end. This is the most common way a
    // real cold-start visitor hits an empty list (a backend hiccup), so it's
    // the load-bearing regression guard for the PR's stated reason to exist.
    fetchMock.mockImplementation(makeFetch({ error: "internal" }, 500));
    const { findByText, queryByTestId } = render(
      <AtlasChat apiUrl="https://api.example.com" apiKey="test-key" />,
    );

    await findByText(DEFAULT_STARTER_PROMPT_TEXTS[0], undefined, { timeout: 5_000 });
    expect(queryByTestId("starter-prompt-skeleton")).toBeNull();
  });

  it("falls back to static prompts when the adaptive fetch 4xx-throws (auth / rate limit)", async () => {
    // A 4xx throws in the SDK → React Query error state, data: undefined →
    // empty list once it settles (after the retry: 1 backoff, ~1s+). The
    // empty state must degrade to the fallback rather than a dead-end, so a
    // first-time visitor with an expired key / rate limit still gets prompts.
    fetchMock.mockImplementation(makeFetch({ error: "unauthorized" }, 401));
    const { findByText, queryByTestId } = render(
      <AtlasChat apiUrl="https://api.example.com" apiKey="test-key" />,
    );

    // Longer timeout: the query only settles after the retry backoff.
    await findByText(DEFAULT_STARTER_PROMPT_TEXTS[0], undefined, { timeout: 10_000 });
    expect(queryByTestId("starter-prompt-skeleton")).toBeNull();
  });

  it("override path never shows the skeleton, even on first paint", async () => {
    // The override prop disables the fetch; the empty-state gate must short-
    // circuit BOTH the skeleton and the fallback so the host owns its empty
    // state. Guards the `!isOverridePath` short-circuit on the loading gate —
    // a disabled React Query reports isPending: true, so dropping that guard
    // (or gating on isPending) would leak the skeleton onto the override path.
    fetchMock.mockImplementation(makeFetch("pending"));
    const { findByText, queryByTestId } = render(
      <AtlasChat apiUrl="https://api.example.com" apiKey="test-key" starterPrompts={["Custom host prompt"]} />,
    );

    await findByText("Custom host prompt", undefined, { timeout: 5_000 });
    expect(queryByTestId("starter-prompt-skeleton")).toBeNull();
  });

  it("empty override array renders the dead-end copy (host opted out of suggestions)", async () => {
    // `starterPrompts={[]}` is the ONLY path to the dead-end copy after this
    // change — the adaptive path substitutes the static fallback instead. The
    // host explicitly chose no suggestions, so we honor it rather than
    // injecting the fallback.
    fetchMock.mockImplementation(makeFetch("pending"));
    const { findByText, queryByTestId } = render(
      <AtlasChat apiUrl="https://api.example.com" apiKey="test-key" starterPrompts={[]} />,
    );

    await findByText("Ask your first question below to get started.", undefined, { timeout: 5_000 });
    expect(queryByTestId("starter-prompt-skeleton")).toBeNull();
    // No fallback chips leaked in despite the empty list.
    expect(queryByTestId("starter-prompt-cold-start")).toBeNull();
  });
});
