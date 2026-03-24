import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { FeatureGate } from "../components/admin/feature-disabled";

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
    const { container } = render(<FeatureGate status={401} feature="Audit" />);
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
