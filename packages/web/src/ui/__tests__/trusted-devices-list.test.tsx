import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, waitFor, fireEvent, cleanup, act, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "../context";
import { TrustedDevicesList } from "../components/admin/security/trusted-devices-list";

// Stubbed AtlasProvider auth — the component never reads it but the provider
// requires the field to be set.
const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

let testQueryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: testQueryClient },
    createElement(
      AtlasProvider,
      {
        config: {
          apiUrl: "http://localhost:3001",
          isCrossOrigin: false as const,
          authClient: stubAuthClient,
        },
      },
      children,
    ),
  );
}

const originalFetch = globalThis.fetch;

interface FetchCall {
  path: string;
  method: string;
}

let calls: FetchCall[];

function mockFetch(handler: (input: { path: string; method: string }) => Response) {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ path, method });
    return Promise.resolve(handler({ path, method }));
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  testQueryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
});

afterEach(() => {
  testQueryClient.clear();
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("TrustedDevicesList", () => {
  test("shows the empty state when no devices are returned", async () => {
    mockFetch(() => jsonResponse({ devices: [] }));

    await act(async () => {
      render(<TrustedDevicesList />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(screen.getByText(/No trusted browsers/)).toBeTruthy();
    });
    expect(screen.getByText(/2FA challenge/)).toBeTruthy();
  });

  test("renders rows with the 'This browser' badge on the current grant", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    mockFetch(() =>
      jsonResponse({
        devices: [
          {
            identifier: "trust-device-here",
            deviceLabel: "Mac · Safari",
            userAgent: null,
            ipAddress: "203.0.113.1",
            createdAt: new Date().toISOString(),
            expiresAt: future,
            isCurrent: true,
          },
          {
            identifier: "trust-device-other",
            deviceLabel: "iPhone · Safari",
            userAgent: null,
            ipAddress: null,
            createdAt: new Date().toISOString(),
            expiresAt: future,
            isCurrent: false,
          },
        ],
      }),
    );

    await act(async () => {
      render(<TrustedDevicesList />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(screen.getByText("Mac · Safari")).toBeTruthy();
    });
    expect(screen.getByText("iPhone · Safari")).toBeTruthy();
    // Badge appears exactly once — only on the current row.
    const badges = screen.getAllByText(/This browser/);
    expect(badges).toHaveLength(1);
  });

  test("revokes a device through the confirm dialog and refetches the list", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    let listResponse = {
      devices: [
        {
          identifier: "trust-device-revoke",
          deviceLabel: "Windows PC · Chrome",
          userAgent: null,
          ipAddress: null,
          createdAt: new Date().toISOString(),
          expiresAt: future,
          isCurrent: false,
        },
      ],
    };

    mockFetch(({ path, method }) => {
      if (method === "GET") return jsonResponse(listResponse);
      if (method === "DELETE" && path.includes("/trust-device-revoke")) {
        listResponse = { devices: [] };
        return jsonResponse({ success: true });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    await act(async () => {
      render(<TrustedDevicesList />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(screen.getByText("Windows PC · Chrome")).toBeTruthy();
    });

    // Click the revoke button on the row.
    const revokeBtn = screen.getByLabelText(/Revoke Windows PC/);
    await act(async () => {
      fireEvent.click(revokeBtn);
    });

    // Confirm dialog opens.
    await waitFor(() => {
      expect(screen.getByText(/Revoke this trusted browser/)).toBeTruthy();
    });

    // Click the destructive Revoke action inside the dialog. There are two
    // buttons named "Revoke" once the dialog opens (row trigger + dialog
    // confirm) — the dialog confirm is rendered as plain text without an
    // aria-label, so we filter to the one inside an alertdialog.
    const revokeActions = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.trim() === "Revoke");
    expect(revokeActions.length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(revokeActions[revokeActions.length - 1]);
    });

    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE" && c.path.includes("trust-device-revoke"))).toBe(
        true,
      );
    });

    // After refetch, the empty state appears.
    await waitFor(() => {
      expect(screen.getByText(/No trusted browsers/)).toBeTruthy();
    });
  });

  test("clears stale per-item error when the dialog is cancelled and reopened", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    let failNext = true;
    mockFetch(({ method }) => {
      if (method === "GET") {
        return jsonResponse({
          devices: [
            {
              identifier: "trust-device-stale",
              deviceLabel: "Mac",
              userAgent: null,
              ipAddress: null,
              createdAt: new Date().toISOString(),
              expiresAt: future,
              isCurrent: false,
            },
          ],
        });
      }
      if (method === "DELETE") {
        if (failNext) {
          failNext = false;
          return jsonResponse(
            { error: "internal_error", message: "Could not revoke this browser. Please retry." },
            500,
          );
        }
        return jsonResponse({ success: true });
      }
      return jsonResponse({}, 500);
    });

    await act(async () => {
      render(<TrustedDevicesList />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(screen.getByText("Mac")).toBeTruthy();
    });

    // First attempt fails, error renders inline.
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Revoke Mac/));
    });
    await waitFor(() => {
      expect(screen.getByText(/Revoke this trusted browser/)).toBeTruthy();
    });
    const revokeActions = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.trim() === "Revoke");
    await act(async () => {
      fireEvent.click(revokeActions[revokeActions.length - 1]);
    });
    await waitFor(() => {
      expect(screen.getByText(/Could not revoke this browser/)).toBeTruthy();
    });

    // User cancels, then reopens the dialog from the row.
    await act(async () => {
      fireEvent.click(screen.getByText("Cancel"));
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Revoke Mac/));
    });

    // The reopened dialog must NOT carry the previous attempt's error —
    // useAdminMutation alone wouldn't clear it until the NEXT mutate.
    await waitFor(() => {
      expect(screen.getByText(/Revoke this trusted browser/)).toBeTruthy();
    });
    expect(screen.queryByText(/Could not revoke this browser/)).toBeNull();
  });

  test("surfaces an inline error and keeps the dialog open on revoke failure", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    mockFetch(({ method }) => {
      if (method === "GET") {
        return jsonResponse({
          devices: [
            {
              identifier: "trust-device-fail",
              deviceLabel: "Linux",
              userAgent: null,
              ipAddress: null,
              createdAt: new Date().toISOString(),
              expiresAt: future,
              isCurrent: false,
            },
          ],
        });
      }
      if (method === "DELETE") {
        return jsonResponse(
          { error: "internal_error", message: "Could not revoke this browser. Please retry." },
          500,
        );
      }
      return jsonResponse({}, 500);
    });

    await act(async () => {
      render(<TrustedDevicesList />, { wrapper: Wrapper });
    });

    await waitFor(() => {
      expect(screen.getByText("Linux")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Revoke Linux/));
    });

    await waitFor(() => {
      expect(screen.getByText(/Revoke this trusted browser/)).toBeTruthy();
    });

    const revokeActions = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.trim() === "Revoke");
    await act(async () => {
      fireEvent.click(revokeActions[revokeActions.length - 1]);
    });

    // Dialog still open, inline error visible.
    await waitFor(() => {
      expect(screen.getByText(/Could not revoke this browser/)).toBeTruthy();
    });
    expect(screen.getByText(/Revoke this trusted browser/)).toBeTruthy();
  });
});
