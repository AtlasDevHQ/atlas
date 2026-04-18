import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "../context";
import { DeleteProviderDialog } from "../components/admin/sso/delete-provider-dialog";
import type { SSOProviderSummary } from "../components/admin/sso/sso-types";

// ── Test helpers ──────────────────────────────────────────────────

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null }),
};

let testQueryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: testQueryClient },
    createElement(
      AtlasProvider,
      { config: { apiUrl: "http://localhost:3001", isCrossOrigin: false as const, authClient: stubAuthClient } },
      children,
    ),
  );
}

function renderWrapped(ui: React.ReactElement) {
  return render(ui, { wrapper });
}

const originalFetch = globalThis.fetch;

function makeProvider(overrides: Partial<SSOProviderSummary> = {}): SSOProviderSummary {
  return {
    id: "prov_test1",
    orgId: "org_test1",
    type: "saml",
    issuer: "https://idp.example.com",
    domain: "example.com",
    enabled: false,
    ssoEnforced: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    verificationToken: "atlas-verify-abc123",
    domainVerified: false,
    domainVerifiedAt: null,
    domainVerificationStatus: "pending",
    ...overrides,
  };
}

// ── Delete Provider Dialog ────────────────────────────────────────

describe("DeleteProviderDialog", () => {
  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ message: "deleted" }), { status: 200 })),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("renders provider details in dialog", () => {
    const provider = makeProvider();
    renderWrapped(
      <DeleteProviderDialog
        open={true}
        onOpenChange={() => {}}
        provider={provider}
        isLastEnabledWithEnforcement={false}
      />,
    );
    expect(document.body.textContent).toContain("example.com");
    expect(document.body.textContent).toContain("saml");
    expect(document.body.textContent).toContain("https://idp.example.com");
  });

  test("delete button is disabled until domain matches", () => {
    const provider = makeProvider();
    renderWrapped(
      <DeleteProviderDialog
        open={true}
        onOpenChange={() => {}}
        provider={provider}
        isLastEnabledWithEnforcement={false}
      />,
    );
    const deleteButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete Provider"),
    );
    expect(deleteButton).toBeDefined();
    expect(deleteButton!.hasAttribute("disabled")).toBe(true);
  });

  test("delete button enables when domain typed correctly", () => {
    const provider = makeProvider();
    renderWrapped(
      <DeleteProviderDialog
        open={true}
        onOpenChange={() => {}}
        provider={provider}
        isLastEnabledWithEnforcement={false}
      />,
    );
    const input = document.querySelector("input");
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: "example.com" } });

    const deleteButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete Provider"),
    );
    expect(deleteButton!.hasAttribute("disabled")).toBe(false);
  });

  test("domain match is case-insensitive", () => {
    const provider = makeProvider();
    renderWrapped(
      <DeleteProviderDialog
        open={true}
        onOpenChange={() => {}}
        provider={provider}
        isLastEnabledWithEnforcement={false}
      />,
    );
    const input = document.querySelector("input");
    fireEvent.change(input!, { target: { value: "EXAMPLE.COM" } });

    const deleteButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete Provider"),
    );
    expect(deleteButton!.hasAttribute("disabled")).toBe(false);
  });

  test("shows enforcement warning when deleting last enabled provider", () => {
    const provider = makeProvider({ enabled: true });
    renderWrapped(
      <DeleteProviderDialog
        open={true}
        onOpenChange={() => {}}
        provider={provider}
        isLastEnabledWithEnforcement={true}
      />,
    );
    expect(document.body.textContent).toContain("last enabled provider");
    expect(document.body.textContent).toContain("automatically disable enforcement");
  });

  test("does not show enforcement warning when not last provider", () => {
    const provider = makeProvider({ enabled: true });
    renderWrapped(
      <DeleteProviderDialog
        open={true}
        onOpenChange={() => {}}
        provider={provider}
        isLastEnabledWithEnforcement={false}
      />,
    );
    expect(document.body.textContent).not.toContain("last enabled provider");
  });

  test("calls delete API and closes dialog on success", async () => {
    const onOpenChange = mock(() => {});
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ message: "deleted" }), { status: 200 })),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const provider = makeProvider();
    renderWrapped(
      <DeleteProviderDialog
        open={true}
        onOpenChange={onOpenChange}
        provider={provider}
        isLastEnabledWithEnforcement={false}
      />,
    );

    const input = document.querySelector("input");
    fireEvent.change(input!, { target: { value: "example.com" } });

    const deleteButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete Provider"),
    );
    fireEvent.click(deleteButton!);

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("disables enforcement before deleting last enabled provider", async () => {
    const onOpenChange = mock(() => {});
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount++;
      // First call = PUT enforcement, second call = DELETE provider
      return Promise.resolve(new Response(
        JSON.stringify(callCount === 1 ? { enforced: false, orgId: "org_test1" } : { message: "deleted" }),
        { status: 200 },
      ));
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const provider = makeProvider({ enabled: true });
    renderWrapped(
      <DeleteProviderDialog
        open={true}
        onOpenChange={onOpenChange}
        provider={provider}
        isLastEnabledWithEnforcement={true}
      />,
    );

    const input = document.querySelector("input");
    fireEvent.change(input!, { target: { value: "example.com" } });

    const deleteButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete Provider"),
    );
    fireEvent.click(deleteButton!);

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
      // Should have made 2 API calls: enforcement disable + delete
      expect((fetchMock as unknown as ReturnType<typeof mock>).mock.calls.length).toBe(2);
    });
  });

  test("does not delete when enforcement disable fails", async () => {
    const onOpenChange = mock(() => {});
    const fetchMock = mock(() =>
      // Enforcement disable fails
      Promise.resolve(new Response(JSON.stringify({ error: "forbidden", message: "Cannot disable" }), { status: 403 })),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const provider = makeProvider({ enabled: true });
    renderWrapped(
      <DeleteProviderDialog
        open={true}
        onOpenChange={onOpenChange}
        provider={provider}
        isLastEnabledWithEnforcement={true}
      />,
    );

    const input = document.querySelector("input");
    fireEvent.change(input!, { target: { value: "example.com" } });

    const deleteButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete Provider"),
    );
    fireEvent.click(deleteButton!);

    // Wait for the API call to complete
    await waitFor(() => {
      expect((fetchMock as unknown as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    });

    // Dialog should NOT have closed (delete was not attempted)
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
