import { afterEach, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";

// Toggleable deploy mode — the EnterpriseUpsell hosted-only branch reads it.
// The factory returns a function that reads `mockDeployMode` at call time, so
// flipping it between tests changes what `useDeployMode()` reports at render.
let mockDeployMode: "saas" | "self-hosted" = "self-hosted";
mock.module("@/ui/hooks/use-deploy-mode", () => ({
  useDeployMode: () => ({
    deployMode: mockDeployMode,
    loading: false,
    error: null,
    resolved: true,
  }),
}));

import {
  EnterpriseUpsell,
  FeatureGate,
  MfaRequiredPlaceholder,
} from "../components/admin/feature-disabled";

describe("FeatureGate", () => {
  test("renders 404 — feature not enabled", () => {
    const { container } = render(<FeatureGate status={404} feature="Scheduled Tasks" />);
    expect(container.textContent).toContain("Scheduled Tasks not enabled");
    expect(container.textContent).toContain("Enable this feature");
  });

  test("renders 403 — access denied", () => {
    const { container } = render(<FeatureGate status={403} feature="Users" />);
    expect(container.textContent).toContain("Access denied");
    expect(container.textContent).toContain("admin role");
  });

  test("renders 401 — authentication required", () => {
    const { container } = render(<FeatureGate status={401} feature="Audit Log" />);
    expect(container.textContent).toContain("Authentication required");
    expect(container.textContent).toContain("sign in");
  });

  test("renders 503 — internal database not configured", () => {
    const { container } = render(<FeatureGate status={503} feature="Custom Domains" />);
    expect(container.textContent).toContain("Internal database not configured");
    expect(container.textContent).toContain("DATABASE_URL");
    expect(container.textContent).toContain("Custom Domains");
  });
});

describe("MfaRequiredPlaceholder", () => {
  // #2486 — neutral copy for an mfa_enrollment_required 403. The bug: the
  // generic 403 path rendered "You need the admin role to access this
  // page." behind the MFA dialog on /admin/model-config. Asserting on the
  // exact strings keeps the wording stable so a future copy refactor
  // doesn't silently regress to the misleading admin-role line.
  test("renders the 'Two-factor required' placeholder", () => {
    const { container } = render(<MfaRequiredPlaceholder feature="AI Provider" />);
    expect(container.textContent).toContain("Two-factor required");
    expect(container.textContent).toContain("AI Provider");
  });

  test("does NOT render the misleading 'admin role' copy", () => {
    const { container } = render(<MfaRequiredPlaceholder feature="AI Provider" />);
    expect(container.textContent).not.toContain("admin role");
    expect(container.textContent).not.toContain("Access denied");
  });
});

describe("EnterpriseUpsell", () => {
  afterEach(() => {
    mockDeployMode = "self-hosted";
  });

  test("ordinary EE feature shows enterprise-upgrade copy (self-hosted)", () => {
    // SSO et al. unlock on self-hosted enterprise, so the upgrade/contact-sales
    // line is correct — even on a self-hosted deployment.
    mockDeployMode = "self-hosted";
    const { container } = render(<EnterpriseUpsell feature="SSO" />);
    expect(container.textContent).toContain("SSO requires an enterprise plan");
    expect(container.textContent).toContain("contact sales");
    expect(container.textContent).toContain("Learn about Atlas Enterprise");
    expect(container.textContent).not.toContain("Atlas Cloud");
  });

  test("SaaS-exclusive feature shows hosted-only copy on self-hosted (#3999)", () => {
    // Proactive is denied on self-hosted even with enterprise enabled, so the
    // "upgrade your plan" copy is wrong — it must read hosted-SaaS-only with an
    // Atlas Cloud CTA, never the enterprise-upgrade line.
    mockDeployMode = "self-hosted";
    const { container } = render(<EnterpriseUpsell feature="Proactive Chat" />);
    expect(container.textContent).toContain("Proactive Chat is an Atlas Cloud feature");
    expect(container.textContent).toContain("Atlas Cloud");
    expect(container.textContent).toContain("Learn about Atlas Cloud");
    expect(container.textContent).not.toContain("requires an enterprise plan");
    expect(container.textContent).not.toContain("contact sales");
  });

  test("SaaS-exclusive feature keeps upgrade copy on SaaS (per-tier gate, not hosted-only)", () => {
    // On the hosted SaaS the proactive denial is a real per-tier gate (a free/
    // locked workspace), so the upgrade path applies — the hosted-only copy
    // would be nonsensical when the user is already on Atlas Cloud.
    mockDeployMode = "saas";
    const { container } = render(<EnterpriseUpsell feature="Proactive Chat" />);
    expect(container.textContent).toContain("Proactive Chat requires an enterprise plan");
    expect(container.textContent).not.toContain("is an Atlas Cloud feature");
  });

  test("server message overrides the hosted-only description body", () => {
    // AdminContentWrapper passes the server's EnterpriseError message through
    // as `message`; the hosted-only branch must surface it (it carries the
    // PROACTIVE_HOSTED_ONLY_MESSAGE wording) rather than the generic fallback.
    mockDeployMode = "self-hosted";
    const { container } = render(
      <EnterpriseUpsell
        feature="Proactive Chat"
        message="Proactive monitoring is available only on Atlas Cloud (the hosted SaaS)."
      />,
    );
    expect(container.textContent).toContain(
      "Proactive monitoring is available only on Atlas Cloud (the hosted SaaS).",
    );
  });
});
