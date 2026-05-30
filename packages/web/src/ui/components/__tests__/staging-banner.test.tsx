import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";

import { StagingBanner } from "@/ui/components/staging-banner";

const originalFetch = globalThis.fetch;

/** URL the component last requested — asserted to pin the `/api/health` endpoint. */
let lastFetchUrl: string | undefined;

/**
 * Replace `fetch` with a stub that records the requested URL and resolves the
 * health probe deterministically. Tests assert `lastFetchUrl` so a regression
 * back to `/api/v1/health` (the original bug) fails here.
 */
function stubHealth(body: unknown, ok = true): void {
  lastFetchUrl = undefined;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    lastFetchUrl = typeof input === "string" ? input : input.toString();
    return Promise.resolve({
      ok,
      status: ok ? 200 : 503,
      json: () => Promise.resolve(body),
    } as Response);
  }) as typeof fetch;
}

/** Flush the `fetch().then()` chain and the resulting React state update. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  lastFetchUrl = undefined;
});

describe("StagingBanner", () => {
  it("renders the amber marker when the health probe reports the staging region", async () => {
    stubHealth({ region: "staging" });

    render(<StagingBanner />);

    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("Staging environment");
    expect(banner.querySelector("a")?.getAttribute("href")).toContain(
      "staging-environment.md",
    );
    expect(lastFetchUrl).toBe("/api/health");
  });

  it("renders nothing on a production region", async () => {
    stubHealth({ region: "us" });

    render(<StagingBanner />);
    await flush();

    expect(screen.queryByRole("status")).toBeNull();
    expect(lastFetchUrl).toBe("/api/health");
  });

  it("renders nothing (and does not throw) when the probe omits a region", async () => {
    stubHealth({});

    render(<StagingBanner />);
    await flush();

    expect(screen.queryByRole("status")).toBeNull();
    expect(lastFetchUrl).toBe("/api/health");
  });

  it("renders nothing when the health probe returns a non-ok status", async () => {
    stubHealth({}, false);

    render(<StagingBanner />);
    await flush();

    expect(screen.queryByRole("status")).toBeNull();
    expect(lastFetchUrl).toBe("/api/health");
  });

  it("aborts the in-flight health probe on unmount", () => {
    let abortSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      abortSignal = init?.signal ?? undefined;
      // Never resolves — the probe stays in flight until unmount aborts it.
      return new Promise<Response>(() => {});
    }) as typeof fetch;

    const { unmount } = render(<StagingBanner />);
    expect(abortSignal?.aborted).toBe(false);

    unmount();
    expect(abortSignal?.aborted).toBe(true);
  });
});
