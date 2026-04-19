import { describe, expect, test } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import type { FetchError } from "@/ui/lib/fetch-error";
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
    const error: FetchError = { message: "Forbidden", status: 403 };
    const { container } = render(
      <MutationErrorSurface error={error} feature="SCIM" />,
    );
    expect(container.textContent).toContain("Access denied");
    expect(container.textContent).toContain("admin role");
  });

  test("401 routes to FeatureGate sign-in copy", () => {
    const error: FetchError = { message: "Unauthorized", status: 401 };
    const { container } = render(
      <MutationErrorSurface error={error} feature="SCIM" />,
    );
    expect(container.textContent).toContain("Authentication required");
  });

  test("503 routes to FeatureGate internal-db copy", () => {
    const error: FetchError = { message: "Unavailable", status: 503 };
    const { container } = render(
      <MutationErrorSurface error={error} feature="Custom Domains" />,
    );
    expect(container.textContent).toContain("Internal database not configured");
    expect(container.textContent).toContain("Custom Domains");
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
