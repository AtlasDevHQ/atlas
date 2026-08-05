import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

// Toggleable deploy mode — the EnterpriseUpsell hosted-only branch reads it.
// The factory returns a function that reads `mockDeployMode` at call time, so
// flipping it between tests changes what `useDeployMode()` reports at render.
let mockDeployMode: "saas" | "self-hosted" = "self-hosted";
void mock.module("@/ui/hooks/use-deploy-mode", () => ({
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
  GATE_STATUSES,
  MfaRequiredPlaceholder,
  type GateStatus,
} from "../components/admin/feature-disabled";

describe("FeatureGate — canned copy (no server message)", () => {
  // These four are the fallback contract: with an empty response body there is
  // nothing to say but the status-derived guess, so the guess must survive.
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

  test("renders 503 — an unexplained outage, NOT a database diagnosis", () => {
    // The arm used to assert "Internal database not configured / Set
    // DATABASE_URL". No route emits that: a missing internal DB answers 404
    // `not_available`, and every real 503 (`permissions_unavailable`, billing
    // check, browser unavailable) carries a message, so it takes the branch
    // above. What reaches HERE is an infra 503 with an HTML body — a
    // restarting service or an unhealthy proxy — where sending the operator
    // to set an already-set variable is the misdirection.
    const { container } = render(<FeatureGate status={503} feature="Custom Domains" />);
    expect(container.textContent).toContain("Custom Domains is unavailable");
    expect(container.textContent).toContain("Retry in a moment");
    expect(container.textContent).not.toContain("DATABASE_URL");
    expect(container.textContent).not.toContain("Internal database not configured");
  });

  test("renders no request-id line when the response carried no id", () => {
    const { container } = render(<FeatureGate status={403} feature="Users" />);
    expect(container.querySelector('[data-testid="feature-gate-request-id"]')).toBeNull();
    expect(container.textContent).not.toContain("Request ID");
  });
});

describe("FeatureGate — the server's message displaces the guess (#5068)", () => {
  // Paired with the block above: each test here asserts the server's sentence
  // is on screen AND that the canned sentence it replaced is not. Only the
  // second half falsifies a gate that renders both.
  test("404 prefers the server message over the config-file line", () => {
    const { container } = render(
      <FeatureGate
        status={404}
        feature="Company Brain"
        message="No internal database configured."
      />,
    );
    expect(container.textContent).toContain("Company Brain not enabled");
    expect(container.textContent).toContain("No internal database configured.");
    expect(container.textContent).not.toContain(
      "Enable this feature in your server configuration",
    );
  });

  test("403 prefers the server message over the admin-role line", () => {
    const { container } = render(
      <FeatureGate status={403} feature="Users" message="Platform admin role required." />,
    );
    expect(container.textContent).toContain("Access denied");
    expect(container.textContent).toContain("Platform admin role required.");
    expect(container.textContent).not.toContain(
      "You need the admin role to access this page.",
    );
  });

  test("401 prefers the server message over the sign-in line", () => {
    // Fixtures are the shapes `managed.ts` / `simple-key.ts` / `byot.ts`
    // actually emit: bare fragments with NO terminal punctuation. An earlier
    // pass appended the canned line to them and shipped "Not signed in Please
    // sign in to access the admin console." on 100% of real 401s — a fixture
    // ending in a period was the only reason that looked fine.
    for (const message of ["Not signed in", "Session expired (idle timeout)"]) {
      const { container } = render(
        <FeatureGate status={401} feature="Audit Log" message={message} />,
      );
      expect(container.textContent).toContain("Authentication required");
      expect(container.textContent).toContain(message);
      expect(container.textContent).not.toContain(
        "Please sign in to access the admin console.",
      );
      cleanup();
    }
  });

  test("401 does not tell a BANNED account to sign in", () => {
    // The case that killed the append outright: `managed.ts:83` answers 401
    // with "Account is banned", and signing in is precisely what will not
    // help. Same for either key-based ATLAS_AUTH_MODE, where there is no
    // sign-in at all. The canned line is not an affordance that survives every
    // cause — it is one more guess, and the server's beats it.
    const { container } = render(
      <FeatureGate status={401} feature="Audit Log" message="Account is banned" />,
    );
    expect(container.textContent).toContain("Account is banned");
    expect(container.textContent).not.toContain("sign in");
  });

  test("503 replaces the whole unexplained-outage line, headline included", () => {
    const { container } = render(
      <FeatureGate
        status={503}
        feature="Custom Domains"
        message="Authorization service is temporarily unavailable."
      />,
    );
    expect(container.textContent).toContain("Custom Domains is unavailable");
    expect(container.textContent).toContain(
      "Authorization service is temporarily unavailable.",
    );
    // The no-message guidance must not tag along behind a real explanation.
    expect(container.textContent).not.toContain("Retry in a moment");
  });

  test("a blank server message does not render an empty description — on ANY arm", () => {
    // `serverMessage` normalizes blanks away, but `FeatureGate` takes a bare
    // `string | undefined` and any caller can hand it one. Icon + headline
    // over an empty <p> is the blank-chrome failure `buildFetchError` exists
    // to prevent, and it is guarded by `||` — a nullish `??` would let ""
    // through. Every arm, because the guard was falsified on exactly one of
    // four and swapping the other three back to `??` changed nothing visible.
    // Hardcoded, NOT `GATE_STATUSES`: iterating the constant means the
    // coverage shrinks with it, so dropping 503 from the set would silently
    // stop testing 503. The set itself is pinned separately below.
    const canned: Record<GateStatus, string> = {
      401: "Please sign in to access the admin console.",
      403: "You need the admin role to access this page.",
      404: "Enable this feature in your server configuration to use this page.",
      503: "Retry in a moment",
    };
    for (const status of [401, 403, 404, 503] as const) {
      for (const blank of ["", "   "]) {
        const { container } = render(
          <FeatureGate status={status} feature="Users" message={blank} />,
        );
        expect(container.textContent).toContain(canned[status]);
        cleanup();
      }
    }
  });
});

describe("FeatureGate — the gated status set", () => {
  test("is exactly 401/403/404/503", () => {
    // The one place a change to the set fails loudly. Every other loop in this
    // file hardcodes the four so its coverage cannot shrink along with the
    // constant; this is where widening or narrowing has to be a decision.
    expect([...GATE_STATUSES]).toEqual([401, 403, 404, 503]);
  });
});

describe("FeatureGate — request id (#5068)", () => {
  const REQUEST_ID = "8f0c1e2a-4b6d-4f1a-9c3e-77d2b5a10e94";

  // Every gated status, not just the one the bug was reported on: a gate that
  // an operator did not expect is un-diagnosable without the correlation id,
  // and 401/403 are the two most likely to arrive unexpectedly.
  for (const status of [401, 403, 404, 503] as const) {
    test(`renders the request id on ${status}`, () => {
      const { container } = render(
        <FeatureGate status={status} feature="Users" requestId={REQUEST_ID} />,
      );
      const line = container.querySelector('[data-testid="feature-gate-request-id"]');
      // `throw` rather than `expect(...).not.toBeNull()` + `line!`: bun's
      // expect does not narrow, and this names the failure.
      if (!line) throw new Error(`no request-id line on the ${status} gate`);
      // Read the id off ITS OWN element, not the container: `toContain` on the
      // whole page passes for an id rendered anywhere, including inside a
      // description that happened to quote it. Exact text, not `toContain`,
      // so dropping the "Request ID:" label — leaving a bare uuid an operator
      // has no reason to recognize — fails here.
      expect(line.textContent).toBe(`Request ID: ${REQUEST_ID}`);
    });
  }

  test("a blank id renders no line rather than a bare label", () => {
    // `extractFetchError` accepts any string, so "   " reaches here. The label
    // over nothing is the same blank-chrome class the message guard prevents.
    for (const blank of ["", "   "]) {
      const { container } = render(
        <FeatureGate status={403} feature="Users" requestId={blank} />,
      );
      expect(container.querySelector('[data-testid="feature-gate-request-id"]')).toBeNull();
      expect(container.textContent).not.toContain("Request ID");
      cleanup();
    }
  });

  test("renders the id alongside a server message rather than instead of it", () => {
    const { container } = render(
      <FeatureGate
        status={404}
        feature="Company Brain"
        message="No internal database configured."
        requestId={REQUEST_ID}
      />,
    );
    expect(container.textContent).toContain("No internal database configured.");
    expect(container.textContent).toContain(REQUEST_ID);
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

  test("carries the request id when one is present (#5068)", () => {
    // The copy stays fixed — see the component doc — but the id is not copy.
    const { container } = render(
      <MfaRequiredPlaceholder feature="AI Provider" requestId="req-mfa-x" />,
    );
    const line = container.querySelector('[data-testid="feature-gate-request-id"]');
    if (!line) throw new Error("MFA placeholder rendered no request-id line");
    expect(line.textContent).toContain("req-mfa-x");
    // Still the enrollment copy, not the server's generic 403 sentence.
    expect(container.textContent).toContain("Enroll an authenticator app or passkey");
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

  test("carries the request id on BOTH arms (#5068)", () => {
    // `enterprise_required` is evaluated before the `FeatureGate` branch, so
    // this is the gated 403 most likely to arrive unexpectedly — an
    // entitlement lookup that misfired for a paying workspace. Both arms,
    // because the hosted-only branch is the one a self-hosted operator hits
    // and it is a separate block of markup.
    for (const [mode, feature] of [
      ["self-hosted", "Proactive Chat"],
      ["saas", "SSO"],
    ] as const) {
      mockDeployMode = mode;
      const { container } = render(
        <EnterpriseUpsell feature={feature} requestId="req-ee-x" />,
      );
      const line = container.querySelector('[data-testid="feature-gate-request-id"]');
      if (!line) throw new Error(`no request-id line on the ${mode} upsell arm`);
      expect(line.textContent).toContain("req-ee-x");
      cleanup();
    }
  });
});
