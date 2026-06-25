/**
 * Tests for onboarding email templates.
 */

import { describe, it, expect } from "bun:test";
import { renderOnboardingEmail, renderInvitationEmail, renderTrialExpiryEmail, renderDunningEmail } from "../templates";
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

  it("first_query asserts the connected DB for a BYO signup (default)", () => {
    const result = renderOnboardingEmail("first_query", BASE_URL, UNSUB_URL);
    expect(result.html).toContain("Your database is connected");
    expect(result.html).not.toContain("Your demo dataset is loaded");
  });

  it("first_query uses demo copy for a demo-only signup (#3962)", () => {
    const result = renderOnboardingEmail("first_query", BASE_URL, UNSUB_URL, null, { demoMode: true });
    // A demo-only signup never connected their own production DB, so the nudge
    // must not assert it (the #3962 bug).
    expect(result.html).not.toContain("Your database is connected");
    expect(result.html).toContain("Your demo dataset is loaded");
  });

  it("explicit demoMode:false keeps BYO copy", () => {
    const result = renderOnboardingEmail("first_query", BASE_URL, UNSUB_URL, null, { demoMode: false });
    expect(result.html).toContain("Your database is connected");
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

describe("renderInvitationEmail", () => {
  const baseArgs = {
    orgName: "Acme Corp",
    inviterName: "Matt Sywulak",
    role: "admin",
    acceptUrl: "https://app.useatlas.dev/accept-invitation/inv-123",
  };

  it("renders subject + valid HTML", () => {
    const result = renderInvitationEmail(baseArgs);
    expect(result.subject).toContain("Acme Corp");
    expect(result.subject).toContain("Atlas");
    expect(result.html).toContain("<!DOCTYPE html>");
    expect(result.html).toContain("Acme Corp");
    expect(result.html).toContain("Matt Sywulak");
    expect(result.html).toContain("admin");
  });

  it("includes the accept URL both as button href and as a copy-paste fallback", () => {
    const result = renderInvitationEmail(baseArgs);
    // The button anchor + the paste-friendly fallback both point at the
    // same URL. Two occurrences is the minimum count — defends against a
    // future refactor that drops one of them.
    const occurrences = result.html.split(baseArgs.acceptUrl).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("uses workspace branding when provided", () => {
    const result = renderInvitationEmail({
      ...baseArgs,
      branding: {
        logoUrl: "https://acme.example/logo.png",
        logoText: "Acme",
        primaryColor: "#FF5500",
        faviconUrl: null,
        hideAtlasBranding: true,
      },
    });
    expect(result.html).toContain("#FF5500");
    expect(result.html).toContain("https://acme.example/logo.png");
    expect(result.subject).toContain("Acme"); // branded app name in subject
  });

  it("falls back to Atlas branding when none provided", () => {
    const result = renderInvitationEmail(baseArgs);
    expect(result.subject).toContain("Atlas");
  });

  it("escapes HTML in the inviter and org names (XSS guard)", () => {
    const result = renderInvitationEmail({
      ...baseArgs,
      inviterName: "<script>alert('x')</script>",
      orgName: "<img onerror=alert(1) src=x>",
    });
    expect(result.html).not.toContain("<script>");
    expect(result.html).not.toContain("<img onerror");
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("does NOT carry the onboarding 'unsubscribe' footer", () => {
    // Invitees aren't Atlas users yet — they have no onboarding
    // preferences row. The invitation footer is a distinct, lighter
    // shape; surface it as a regression test so a future refactor that
    // accidentally reuses the onboarding wrap() doesn't reintroduce a
    // broken unsubscribe link.
    const result = renderInvitationEmail(baseArgs);
    expect(result.html).not.toContain("Unsubscribe");
    expect(result.html).not.toContain("/api/v1/onboarding-emails/unsubscribe");
  });
});

describe("renderTrialExpiryEmail", () => {
  const endsAt = new Date("2026-06-20T00:00:00.000Z");

  it("renders the T-3d warning with the effective end date and upgrade CTA", () => {
    const result = renderTrialExpiryEmail("trial_ending_3d", {
      baseUrl: BASE_URL,
      trialEndsAt: endsAt,
    });
    expect(result.subject).toBe("Your Atlas trial ends in 3 days");
    expect(result.html).toContain("June 20, 2026");
    expect(result.html).toContain(`${BASE_URL}/admin/billing`);
    expect(result.html).toContain("Choose a plan");
  });

  it("renders the T-1d warning with singular copy", () => {
    const result = renderTrialExpiryEmail("trial_ending_1d", {
      baseUrl: BASE_URL,
      trialEndsAt: endsAt,
    });
    expect(result.subject).toBe("Your Atlas trial ends tomorrow");
    expect(result.html).toContain("Your trial ends tomorrow");
    expect(result.html).not.toContain("1 days");
  });

  it("renders the expiry notice without an unsubscribe link (transactional)", () => {
    const result = renderTrialExpiryEmail("trial_expired", {
      baseUrl: BASE_URL,
      trialEndsAt: endsAt,
    });
    expect(result.subject).toBe("Your Atlas trial has expired");
    expect(result.html).toContain("Your trial has expired");
    expect(result.html).toContain("billing notice");
    expect(result.html).not.toContain("Unsubscribe");
  });

  it("applies workspace branding to subject and body", () => {
    const result = renderTrialExpiryEmail("trial_expired", {
      baseUrl: BASE_URL,
      trialEndsAt: endsAt,
      branding: {
        logoUrl: null,
        logoText: "Acme Corp",
        primaryColor: "#FF5500",
        faviconUrl: null,
        hideAtlasBranding: true,
      },
    });
    expect(result.subject).toBe("Your Acme Corp trial has expired");
    expect(result.html).toContain("Acme Corp");
  });
});

describe("renderDunningEmail", () => {
  it("renders the past_due warning with the billing CTA, entitlements-retained copy", () => {
    const result = renderDunningEmail("dunning_past_due", { baseUrl: BASE_URL });
    expect(result.subject).toBe("Action needed: your Atlas payment didn't go through");
    expect(result.html).toContain(`${BASE_URL}/admin/billing`);
    expect(result.html).toContain("still fully active");
    expect(result.html).toContain("Update payment method");
  });

  it("renders the unpaid notice as a workspace-paused block", () => {
    const result = renderDunningEmail("dunning_unpaid", { baseUrl: BASE_URL });
    expect(result.subject).toBe("Your Atlas workspace is paused — update your payment method");
    expect(result.html).toContain("paused for your workspace");
  });

  it("renders the suspended final notice", () => {
    const result = renderDunningEmail("dunning_suspended", { baseUrl: BASE_URL });
    expect(result.subject).toBe("Final notice: your Atlas workspace has been suspended");
    expect(result.html).toContain("suspended");
  });

  it("renders the recovery confirmation", () => {
    const result = renderDunningEmail("dunning_recovered", { baseUrl: BASE_URL });
    expect(result.subject).toBe("You're all set — Atlas access restored");
    expect(result.html).toContain("fully active again");
  });

  it("is transactional — carries no unsubscribe link", () => {
    const result = renderDunningEmail("dunning_past_due", { baseUrl: BASE_URL });
    expect(result.html).toContain("billing notice");
    expect(result.html).not.toContain("Unsubscribe");
  });

  it("applies workspace branding to subject and body", () => {
    const result = renderDunningEmail("dunning_unpaid", {
      baseUrl: BASE_URL,
      branding: {
        logoUrl: null,
        logoText: "Acme Corp",
        primaryColor: "#FF5500",
        faviconUrl: null,
        hideAtlasBranding: true,
      },
    });
    expect(result.subject).toBe("Your Acme Corp workspace is paused — update your payment method");
    expect(result.html).toContain("Acme Corp");
  });
});
