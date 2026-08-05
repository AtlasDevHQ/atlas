import { describe, expect, test, mock, spyOn } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import type { FetchError } from "@/ui/lib/fetch-error";

// EnterpriseUpsell now reads useDeployMode (→ useAdminFetch → useAtlasConfig) to
// pick hosted-only vs upgrade copy for SaaS-exclusive features (#3999). These
// tests render it in isolation (no <AtlasProvider>), so stub the hook to a
// stable mode. The features used here are non-SaaS-exclusive (SSO/Custom
// Domains), so the mode never flips the copy — the stub just severs the
// provider/network dependency.
void mock.module("@/ui/hooks/use-deploy-mode", () => ({
  useDeployMode: () => ({
    deployMode: "self-hosted",
    loading: false,
    error: null,
    resolved: true,
  }),
}));

import { MutationErrorSurface } from "../mutation-error-surface";

/**
 * Coverage maps to the decision tree in `mutation-error-surface.tsx`:
 *   null → null
 *   code="enterprise_required" → EnterpriseUpsell (banner) / compact inline upsell (inline)
 *   status in {401,403,404,503} → FeatureGate (banner only)
 *   otherwise → ErrorBanner (banner) or InlineError-with-optional-prefix (inline)
 *
 * A regression that drops `.code` routing (e.g. reverts to substring matching
 * on `.message`) or collapses the two variants into one would fail at least
 * one case here.
 */

describe("MutationErrorSurface", () => {
  test("null error renders nothing", () => {
    const { container } = render(
      <MutationErrorSurface error={null} feature="SSO" />,
    );
    expect(container.textContent).toBe("");
  });

  test("enterprise_required (banner) routes to EnterpriseUpsell with feature + server message", () => {
    const error: FetchError = {
      message: "Enterprise tier required to use SSO.",
      status: 403,
      code: "enterprise_required",
    };
    const { container } = render(
      <MutationErrorSurface error={error} feature="SSO" />,
    );
    expect(container.textContent).toContain("SSO requires an enterprise plan");
    // Preserves the server-provided message as the description, not the
    // generic fallback copy — this is what proves we routed through
    // EnterpriseUpsell's `message` prop rather than ErrorBanner.
    expect(container.textContent).toContain(
      "Enterprise tier required to use SSO.",
    );
    const link = container.querySelector('a[href*="useatlas.dev/enterprise"]');
    expect(link).not.toBeNull();
    // Banner variant never renders inside the small InlineError chrome, so
    // the destructive/10 background class can't appear here.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("FeatureGate status codes route to FeatureGate (banner variant)", () => {
    // The status-derived headline is what proves the routing; the description
    // now belongs to the server (#5068), so it can't stand in as the marker.
    const error: FetchError = {
      message: "Admin role required.",
      status: 403,
      code: "forbidden_role",
    };
    const { container } = render(
      <MutationErrorSurface error={error} feature="SCIM" />,
    );
    expect(container.textContent).toContain("Access denied");
    expect(container.textContent).toContain("Admin role required.");
  });

  test("401 routes to FeatureGate sign-in copy, carrying the server's message", () => {
    const error: FetchError = { message: "No user ID in session.", status: 401 };
    const { container } = render(
      <MutationErrorSurface error={error} feature="SCIM" />,
    );
    expect(container.textContent).toContain("Authentication required");
    // Without this the fixture is inert — the test passed identically with
    // `message` dropped from the props.
    expect(container.textContent).toContain("No user ID in session.");
    expect(container.textContent).not.toContain(
      "Please sign in to access the admin console.",
    );
  });

  test("503 with no server message keeps the unexplained-outage copy", () => {
    // `HTTP 503` is what `extractFetchError` leaves behind on an empty body —
    // the only shape that legitimately falls back. Writing an invented
    // one-word message here instead would assert the fallback on an input that
    // no longer takes it, and pass for the wrong reason.
    const error: FetchError = { message: "HTTP 503", status: 503 };
    const { container } = render(
      <MutationErrorSurface error={error} feature="Custom Domains" />,
    );
    expect(container.textContent).toContain("Custom Domains is unavailable");
    expect(container.textContent).toContain("Retry in a moment");
  });

  test("503 with a server message routes to FeatureGate carrying it (#5068)", () => {
    const error: FetchError = {
      message: "Authorization service is temporarily unavailable.",
      status: 503,
      code: "permissions_unavailable",
      requestId: "req-503-mut",
    };
    const { container } = render(
      <MutationErrorSurface error={error} feature="Custom Domains" />,
    );
    expect(container.textContent).toContain(
      "Authorization service is temporarily unavailable.",
    );
    expect(container.textContent).not.toContain("Internal database not configured");
    expect(container.textContent).toContain("req-503-mut");
  });

  test("inline enterprise upsell drops the HTTP placeholder rather than reading it out", () => {
    // The inline variant renders its message inline with the headline, so an
    // empty `enterprise_required` body used to produce
    // "SSO requires Enterprise. HTTP 403 Learn more".
    const error: FetchError = {
      message: "HTTP 403",
      status: 403,
      code: "enterprise_required",
    };
    const { container } = render(
      <MutationErrorSurface error={error} feature="SSO" variant="inline" />,
    );
    expect(container.textContent).toContain("SSO requires Enterprise.");
    expect(container.textContent).not.toContain("HTTP 403");
  });

  test("BANNER enterprise upsell drops the HTTP placeholder too", () => {
    // The inline sibling above had this arm and the banner one did not, so
    // reverting the banner call site to `message={error.message}` survived
    // the whole suite — every other enterprise fixture carries a real body,
    // where `authored` and `error.message` are indistinguishable.
    const error: FetchError = {
      message: "HTTP 403",
      status: 403,
      code: "enterprise_required",
    };
    const { container } = render(
      <MutationErrorSurface error={error} feature="SSO" />,
    );
    expect(container.textContent).toContain("SSO requires an enterprise plan");
    expect(container.textContent).toContain("contact sales");
    expect(container.textContent).not.toContain("HTTP 403");
  });

  test("the enterprise upsell carries the request id, like every other gated surface", () => {
    // `enterprise_required` is evaluated one branch BEFORE the gate, so it
    // was the class of 403 most likely to arrive unexpectedly — a paying
    // workspace whose entitlement lookup misfired — and the only one that
    // reached the operator with no log handle.
    const error: FetchError = {
      message: "Enterprise tier required to use SSO.",
      status: 403,
      code: "enterprise_required",
      requestId: "req-ee-gate",
    };
    const { container } = render(
      <MutationErrorSurface error={error} feature="SSO" />,
    );
    const line = container.querySelector('[data-testid="feature-gate-request-id"]');
    if (!line) throw new Error("enterprise upsell rendered no request-id line");
    expect(line.textContent).toContain("req-ee-gate");
  });

  test("enterprise_required without a status still routes to EnterpriseUpsell", () => {
    // Locks the ordering of the two gate checks inside the banner branch.
    // A refactor that puts the `status in {401,403,404,503}` check first
    // would still pass the other enterprise_required tests (they all have
    // status 403), but would silently drop a code-only error into
    // FeatureGate instead of EnterpriseUpsell.
    const error: FetchError = {
      message: "Enterprise required",
      code: "enterprise_required",
    };
    const { container } = render(
      <MutationErrorSurface error={error} feature="SSO" />,
    );
    expect(container.textContent).toContain("SSO requires an enterprise plan");
    expect(container.querySelector('a[href*="useatlas.dev/enterprise"]')).not.toBeNull();
  });

  test("status outside {401,403,404,503} falls through to ErrorBanner, not FeatureGate", () => {
    // Locks the whitelist semantics on the FeatureGate gate. A refactor that
    // replaces `[401,403,404,503].includes(error.status)` with a truthy check
    // would render FeatureGate for 429/500/... and break the cast
    // `as 401 | 403 | 404 | 503`. 429 is the canonical "known status code
    // that MUST NOT route to FeatureGate" — rate-limited mutations should
    // render the generic banner with retry.
    const error: FetchError = { message: "Too Many Requests", status: 429 };
    const { container } = render(
      <MutationErrorSurface error={error} feature="Billing" />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Too Many Requests");
    // FeatureGate uses h-full + centered copy — the "Access denied" text
    // must not appear.
    expect(container.textContent).not.toContain("Access denied");
  });

  test("plain error (banner) renders ErrorBanner with friendlyError message + requestId", () => {
    const error: FetchError = {
      message: "Upstream failed",
      status: 500,
      requestId: "req-42",
    };
    const { container } = render(
      <MutationErrorSurface error={error} feature="SSO" />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Upstream failed");
    expect(alert!.textContent).toContain("req-42");
  });

  test("onRetry (banner) wires Retry button to callback", () => {
    const error: FetchError = { message: "Upstream failed", status: 500 };
    let retried = 0;
    const { container } = render(
      <MutationErrorSurface
        error={error}
        feature="SSO"
        onRetry={() => {
          retried++;
        }}
      />,
    );
    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(button).toBeDefined();
    fireEvent.click(button!);
    expect(retried).toBe(1);
  });

  test("inline variant renders InlineError styling + friendly message", () => {
    const error: FetchError = { message: "Upstream failed", status: 500 };
    const { container } = render(
      <MutationErrorSurface error={error} feature="Billing" variant="inline" />,
    );
    const inline = container.querySelector(".bg-destructive\\/10");
    expect(inline).not.toBeNull();
    expect(inline!.textContent).toContain("Upstream failed");
    // Inline variant must NOT render the `role="alert"` chrome — that's the
    // ErrorBanner surface and would break the visual weight inside compact rows.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("inline variant with prefix renders bold prefix before message", () => {
    const error: FetchError = { message: "Upstream failed", status: 500 };
    const { container } = render(
      <MutationErrorSurface
        error={error}
        feature="Branding"
        variant="inline"
        inlinePrefix="Save failed."
      />,
    );
    const bold = container.querySelector(".font-semibold");
    expect(bold?.textContent).toBe("Save failed.");
    expect(container.textContent).toContain("Upstream failed");
  });

  test("warns in dev when inline variant receives onRetry (cross-variant misuse)", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error: FetchError = { message: "Upstream failed", status: 500 };
    render(
      <MutationErrorSurface
        error={error}
        feature="SSO"
        variant="inline"
        onRetry={mock(() => {})}
      />,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("onRetry` is banner-only"),
    );
    warn.mockRestore();
  });

  test("warns in dev when banner variant receives inlinePrefix (cross-variant misuse)", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error: FetchError = { message: "Upstream failed", status: 500 };
    render(
      <MutationErrorSurface
        error={error}
        feature="SSO"
        inlinePrefix="Save failed."
      />,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("inlinePrefix` is inline-only"),
    );
    warn.mockRestore();
  });

  test("inline variant + enterprise_required renders compact inline upsell (not full EnterpriseUpsell)", () => {
    const error: FetchError = {
      message: "Enterprise tier required — contact sales@example.com",
      status: 403,
      code: "enterprise_required",
    };
    const { container } = render(
      <MutationErrorSurface error={error} feature="BYOT" variant="inline" />,
    );
    // Compact upsell still points at the enterprise page, so callers don't
    // lose the routing win at inline sites — but it sits inside the
    // InlineError chrome, not a full-page upsell card (no "Learn about Atlas
    // Enterprise" button, no centered card).
    const link = container.querySelector('a[href*="useatlas.dev/enterprise"]');
    expect(link).not.toBeNull();
    expect(container.textContent).toContain("BYOT");
    expect(container.textContent).toContain("Enterprise");
    // Server-provided message must survive — banner variant passes it via
    // EnterpriseUpsell.message, inline variant must render it too or the
    // specific guidance ("contact sales@...") silently drops.
    expect(container.textContent).toContain(
      "Enterprise tier required — contact sales@example.com",
    );
    // Inline chrome (not the centered card with the shield icon and button).
    expect(container.querySelector(".bg-destructive\\/10")).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("Learn about Atlas Enterprise"),
      ),
    ).toBe(false);
  });
});
