import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "../context";
import { ProviderCard } from "../components/admin/sso/provider-card";
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

// ── Provider Card ─────────────────────────────────────────────────

describe("ProviderCard", () => {
  const noop = () => {};

  beforeEach(() => {
    testQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
  });

  afterEach(() => {
    testQueryClient.clear();
    cleanup();
  });

  test("renders provider domain and type badge", () => {
    const provider = makeProvider();
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    expect(container.textContent).toContain("example.com");
    expect(container.textContent).toContain("saml");
  });

  test("renders issuer URL", () => {
    const provider = makeProvider();
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    expect(container.textContent).toContain("https://idp.example.com");
  });

  test("renders pending verification badge for pending status", () => {
    const provider = makeProvider({ domainVerificationStatus: "pending" });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    expect(container.textContent).toContain("Pending");
  });

  test("renders verified badge for verified status", () => {
    const provider = makeProvider({
      domainVerificationStatus: "verified",
      domainVerified: true,
    });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    expect(container.textContent).toContain("Verified");
  });

  test("renders failed badge for failed status", () => {
    const provider = makeProvider({ domainVerificationStatus: "failed" });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    expect(container.textContent).toContain("Failed");
  });

  test("shows Verify button when domain is not verified", () => {
    const provider = makeProvider({ domainVerificationStatus: "pending" });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    expect(container.textContent).toContain("Verify");
  });

  test("hides Verify button when domain is verified", () => {
    const provider = makeProvider({
      domainVerificationStatus: "verified",
      domainVerified: true,
    });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const verifyButton = buttons.find((b) => b.textContent?.includes("Verify"));
    expect(verifyButton).toBeUndefined();
  });

  test("calls onVerifyDomain when Verify button clicked", () => {
    const provider = makeProvider();
    const onVerify = mock(noop);
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={onVerify}
        isToggling={false}
        isVerifying={false}
      />,
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    const verifyButton = buttons.find((b) => b.textContent?.includes("Verify"));
    expect(verifyButton).toBeDefined();
    fireEvent.click(verifyButton!);
    expect(onVerify).toHaveBeenCalledTimes(1);
    expect(onVerify).toHaveBeenCalledWith(provider);
  });

  test("calls onEdit when edit button clicked", () => {
    const provider = makeProvider();
    const onEdit = mock(noop);
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={onEdit}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    const editButton = container.querySelector('[aria-label="Edit provider"]');
    expect(editButton).not.toBeNull();
    fireEvent.click(editButton!);
    expect(onEdit).toHaveBeenCalledWith(provider);
  });

  test("calls onDelete when delete button clicked", () => {
    const provider = makeProvider();
    const onDelete = mock(noop);
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={onDelete}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    const deleteButton = container.querySelector('[aria-label="Delete provider"]');
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);
    expect(onDelete).toHaveBeenCalledWith(provider);
  });

  test("shows DNS TXT record when domain is not verified", () => {
    const provider = makeProvider({ verificationToken: "atlas-verify-xyz" });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    expect(container.textContent).toContain("atlas-verify-xyz");
    expect(container.textContent).toContain("_atlas-verify.example.com");
  });

  test("shows OIDC type badge for OIDC providers", () => {
    const provider = makeProvider({ type: "oidc" });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    expect(container.textContent).toContain("oidc");
  });

  test("shows SP Metadata section for SAML providers", () => {
    const provider = makeProvider({ type: "saml" });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    expect(container.textContent).toContain("SP Metadata");
  });

  test("does not show SP Metadata for OIDC providers", () => {
    const provider = makeProvider({ type: "oidc" });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    expect(container.textContent).not.toContain("SP Metadata");
  });

  test("toggle is disabled when domain not verified and provider disabled", () => {
    const provider = makeProvider({ domainVerificationStatus: "pending", enabled: false });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl).not.toBeNull();
    expect(switchEl!.getAttribute("aria-checked")).toBe("false");
    expect(switchEl!.hasAttribute("disabled") || switchEl!.getAttribute("data-disabled") !== null).toBe(true);
  });

  test("toggle is enabled when domain is verified", () => {
    const provider = makeProvider({ domainVerificationStatus: "verified", domainVerified: true, enabled: false });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    const switchEl = container.querySelector('[role="switch"]');
    expect(switchEl).not.toBeNull();
    expect(switchEl!.hasAttribute("disabled")).toBe(false);
  });

  test("hides DNS TXT record when domain is verified", () => {
    const provider = makeProvider({
      domainVerificationStatus: "verified",
      domainVerified: true,
      verificationToken: "atlas-verify-xyz",
    });
    const { container } = renderWrapped(
      <ProviderCard
        provider={provider}
        onEdit={noop}
        onDelete={noop}
        onToggleEnabled={noop}
        onVerifyDomain={noop}
        isToggling={false}
        isVerifying={false}
      />,
    );
    expect(container.textContent).not.toContain("atlas-verify-xyz");
  });
});

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
