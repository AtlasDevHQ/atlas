/**
 * Tests for onboarding email templates.
 */

import { describe, it, expect } from "bun:test";
import { renderOnboardingEmail } from "../templates";
import type { OnboardingEmailStep } from "@useatlas/types";

const BASE_URL = "https://app.useatlas.dev";
const UNSUB_URL = "https://app.useatlas.dev/api/v1/onboarding-emails/unsubscribe?userId=u1";

describe("renderOnboardingEmail", () => {
  const steps: OnboardingEmailStep[] = [
    "welcome",
    "connect_database",
    "first_query",
    "invite_team",
    "explore_features",
  ];

  for (const step of steps) {
    it(`renders ${step} email with valid HTML`, () => {
      const result = renderOnboardingEmail(step, BASE_URL, UNSUB_URL);
      expect(result.subject).toBeTruthy();
      expect(result.html).toContain("<!DOCTYPE html>");
      expect(result.html).toContain(UNSUB_URL);
      expect(result.html).toContain("Atlas");
    });
  }

  it("applies workspace branding", () => {
    const result = renderOnboardingEmail("welcome", BASE_URL, UNSUB_URL, {
      logoUrl: "https://example.com/logo.png",
      logoText: "Acme Corp",
      primaryColor: "#FF5500",
      faviconUrl: null,
      hideAtlasBranding: true,
    });

    expect(result.subject).toContain("Acme Corp");
    expect(result.html).toContain("Acme Corp");
    expect(result.html).toContain("#FF5500");
    expect(result.html).toContain("https://example.com/logo.png");
  });

  it("uses default branding when none provided", () => {
    const result = renderOnboardingEmail("welcome", BASE_URL, UNSUB_URL, null);
    expect(result.subject).toContain("Atlas");
    expect(result.html).toContain("Atlas");
  });

  it("includes unsubscribe link in all emails", () => {
    for (const step of steps) {
      const result = renderOnboardingEmail(step, BASE_URL, UNSUB_URL);
      expect(result.html).toContain("Unsubscribe");
      expect(result.html).toContain(UNSUB_URL);
    }
  });

  it("includes action buttons with correct URLs", () => {
    const result = renderOnboardingEmail("connect_database", BASE_URL, UNSUB_URL);
    expect(result.html).toContain(`${BASE_URL}/admin/connections`);
  });

  it("escapes HTML in branding text", () => {
    const result = renderOnboardingEmail("welcome", BASE_URL, UNSUB_URL, {
      logoUrl: null,
      logoText: "<script>alert('xss')</script>",
      primaryColor: null,
      faviconUrl: null,
      hideAtlasBranding: false,
    });
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });
});
