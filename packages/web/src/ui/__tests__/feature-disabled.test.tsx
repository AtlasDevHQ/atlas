import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import {
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
