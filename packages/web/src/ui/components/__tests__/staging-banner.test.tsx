import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";

import { StagingBanner } from "@/ui/components/staging-banner";

const originalFetch = globalThis.fetch;

/** Replace `fetch` with a stub that resolves the health probe deterministically. */
function stubHealth(body: unknown, ok = true): void {
  globalThis.fetch = (() =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 503,
      json: () => Promise.resolve(body),
    } as Response)) as typeof fetch;
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
  });

  it("renders nothing on a production region", async () => {
    stubHealth({ region: "us" });

    render(<StagingBanner />);
    await flush();

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing (and does not throw) when the probe omits a region", async () => {
    stubHealth({});

    render(<StagingBanner />);
    await flush();

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing when the health probe returns a non-ok status", async () => {
    stubHealth({}, false);

    render(<StagingBanner />);
    await flush();

    expect(screen.queryByRole("status")).toBeNull();
  });
});
