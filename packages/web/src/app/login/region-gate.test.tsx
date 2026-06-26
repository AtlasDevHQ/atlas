/**
 * LoginRegionGate (ADR-0024 §3, #3973) — the email-first region step.
 *
 * Pins the four front-door verdicts the gate renders: single (apply signal +
 * reload), multiple (chooser), none (signup nudge), skip/error. The pure
 * fan-out logic is covered in lib/__tests__/login-frontdoor.test.ts.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// Mock api-url: spread real exports, spy on applyRegionSignal.
import * as realApiUrl from "@/lib/api-url";
const applyRegionSignalMock = mock((_region: string, _apiUrl: string): boolean => true);
mock.module("@/lib/api-url", () => ({
  ...realApiUrl,
  applyRegionSignal: (region: string, apiUrl: string) => applyRegionSignalMock(region, apiUrl),
}));

const { LoginRegionGate } = await import("./region-gate");

const reloadMock = mock(() => {});
Object.defineProperty(window, "location", {
  value: { ...window.location, reload: reloadMock },
  configurable: true,
});

const fetchMock = mock(async (): Promise<Response> => new Response("{}"));
const originalFetch = globalThis.fetch;
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

function respondWith(body: unknown, status = 200): void {
  fetchMock.mockImplementationOnce(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

/** Render the gate with internal email state so typing/clicking works. */
function renderGate(initialEmail = "alice@corp.com") {
  const onResolved = mock(() => {});
  let email = initialEmail;
  const view = render(
    <LoginRegionGate email={email} onEmailChange={(e) => (email = e)} onResolved={onResolved} />,
  );
  return { onResolved, view };
}

beforeEach(() => {
  applyRegionSignalMock.mockClear();
  reloadMock.mockClear();
  fetchMock.mockClear();
});
afterEach(() => cleanup());

describe("LoginRegionGate", () => {
  it("posts the email to the front-door and routes a single hit (applies signal + reloads)", async () => {
    respondWith({ outcome: "single", region: "eu", apiUrl: "https://api-eu.useatlas.dev" });
    renderGate();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(applyRegionSignalMock).toHaveBeenCalledTimes(1));
    expect(applyRegionSignalMock).toHaveBeenCalledWith("eu", "https://api-eu.useatlas.dev");
    expect(reloadMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/login/resolve-region");
    expect(JSON.parse(init.body as string)).toEqual({ email: "alice@corp.com" });
  });

  it("renders a region chooser for a multi-region account", async () => {
    respondWith({
      outcome: "multiple",
      regions: [
        { region: "eu", apiUrl: "https://api-eu.useatlas.dev", label: "Europe" },
        { region: "us", apiUrl: "https://api.useatlas.dev", label: "United States" },
      ],
    });
    renderGate();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.getByText("Europe")).toBeDefined());
    expect(screen.getByText("United States")).toBeDefined();
    expect(applyRegionSignalMock).not.toHaveBeenCalled();

    // Picking a region applies that region's signal and reloads.
    fireEvent.click(screen.getByRole("button", { name: /Europe/i }));
    await waitFor(() => expect(applyRegionSignalMock).toHaveBeenCalledWith("eu", "https://api-eu.useatlas.dev"));
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("shows a signup nudge when no account exists in any region", async () => {
    respondWith({ outcome: "none" });
    renderGate();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/couldn't find an account/i)).toBeDefined());
    expect(screen.getByRole("link", { name: /create one/i }).getAttribute("href")).toBe("/signup");
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("reveals the credentials form (onResolved) without reloading on skip", async () => {
    respondWith({ outcome: "skip" });
    const { onResolved } = renderGate();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(reloadMock).not.toHaveBeenCalled();
    expect(applyRegionSignalMock).not.toHaveBeenCalled();
  });

  it("surfaces a retryable error and does not mis-route", async () => {
    respondWith({ outcome: "error", message: "Could not reach the region directory. Please try again." }, 502);
    renderGate();
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/region directory/i)).toBeDefined());
    expect(applyRegionSignalMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid email before any network call", async () => {
    renderGate("not-an-email");
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/valid email/i)).toBeDefined());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Restore fetch for any sibling suite.
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});
