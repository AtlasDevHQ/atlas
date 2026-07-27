/**
 * #4837 — a fail-closed deployment must read as an OUTAGE on /admin/sandbox.
 *
 * Both views were wrong, in different ways. The self-hosted view rendered the
 * raw `"fail-closed"` string in the monospace "Active" slot, reading as one more
 * backend id — the symptom the issue is named after. The SaaS view was worse: it
 * never rendered `activeBackend` at all and derived "Managed is live" from
 * `!connectedProviders.some(isActive)`, so a region whose explore was refusing
 * every request showed "Atlas Cloud Sandbox · Live". A green light on a total
 * outage, on the page an operator opens to diagnose exactly that.
 *
 * Reachable in production both ways: the SaaS pin (#4828 — see
 * `formatSandboxFailClosed`), and self-hosted via `ATLAS_SANDBOX=nsjail` with no
 * usable binary (#4829).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider, type AtlasAuthClient } from "@/ui/context";
import { SandboxStatusSchema, type SandboxStatus } from "@/ui/lib/admin-schemas";

// ── Fixtures ──────────────────────────────────────────────────────
// Every fixture is round-tripped through the SHARED wire schema before it
// reaches a component, so a fixture cannot drift from the contract the API
// emits — the drift that produced #4837 in the first place.

function asWirePayload(status: SandboxStatus): SandboxStatus {
  return SandboxStatusSchema.parse(status);
}

/**
 * An abridged but structurally faithful remediation. The real
 * `formatSandboxFailClosed` output also appends an `Unavailable: …` clause and a
 * sentence about BYOC/plugin front-of-line; byte-parity with the real formatter
 * is enforced in `packages/api/src/api/__tests__/admin-sandbox-fail-closed.test.ts`,
 * not here. What matters here is that the page renders the server's string
 * verbatim rather than composing its own.
 */
const REMEDIATION =
  "Explore tool: UNAVAILABLE — every backend in sandbox.priority (vercel-sandbox) is " +
  "unavailable and the pin has no 'just-bash' fallback, so the tool fails closed and " +
  "refuses every request. For Vercel Sandbox off-Vercel, set VERCEL_TEAM_ID, " +
  "VERCEL_PROJECT_ID, and VERCEL_TOKEN.";

function failClosedStatus(overrides: Partial<SandboxStatus> = {}): SandboxStatus {
  return asWirePayload({
    activeBackend: null,
    platformDefault: null,
    workspaceOverride: null,
    workspaceSidecarUrl: null,
    availableBackends: [
      { id: "vercel-sandbox", name: "Vercel Sandbox", type: "built-in", available: false },
    ],
    connectedProviders: [],
    failClosed: { remediation: REMEDIATION },
    ...overrides,
  });
}

function healthyStatus(overrides: Partial<SandboxStatus> = {}): SandboxStatus {
  return asWirePayload({
    activeBackend: "vercel-sandbox",
    platformDefault: "vercel-sandbox",
    workspaceOverride: null,
    workspaceSidecarUrl: null,
    availableBackends: [
      { id: "vercel-sandbox", name: "Vercel Sandbox", type: "built-in", available: true },
    ],
    connectedProviders: [],
    ...overrides,
  });
}

// ── Hook mocks ────────────────────────────────────────────────────
//
// `SelfHostedSandboxView` reads its status through `useConfigForm` →
// `useAdminFetch` rather than taking it as a prop, so the fetch has to be staged.
//
// EVERY returned value here is a module-level singleton, and that is not
// tidiness — it is required. The real hooks return referentially stable
// functions (`useCallback`), and components depend on that: `ProviderRow` has
// `useEffect(..., [isConnected, clearConnectError])`. A mock that returns a
// fresh object literal per call hands React a new `clearError` identity on every
// render, so that effect re-runs, calls `setState`, re-renders, and loops
// forever — synchronously. The suite then hangs with NO output and survives
// `--timeout`, because the blocked event loop never lets the timer fire. Rebuild
// these objects per call and you will spend an hour finding it again.
//
// `stagedStatus` is set per test BEFORE render for the same identity reason:
// `useConfigForm` re-baselines when `data` changes identity, so a fresh object
// per render would re-baseline forever.

let stagedStatus: SandboxStatus;

const adminFetchReturn = {
  get data() {
    return stagedStatus;
  },
  loading: false,
  error: null,
  setError: () => {},
  refetch: () => {},
};
const inProgressSet = { has: () => false, start: () => {}, stop: () => {} };

void mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => adminFetchReturn,
  useInProgressSet: () => inProgressSet,
  friendlyError: (e: { message: string }) => e.message,
}));

const adminMutationReturn = {
  mutate: async () => ({ ok: true as const, data: undefined }),
  saving: false,
  error: null,
  clearError: () => {},
  errorsByItemId: {},
  isMutating: () => false,
  reset: () => {},
};

void mock.module("@/ui/hooks/use-admin-mutation", () => ({
  useAdminMutation: () => adminMutationReturn,
}));

const { SaasSandboxView, SandboxOutageNotice, SelfHostedSandboxView } = await import("../page");
stagedStatus = healthyStatus();

// ── Harness ───────────────────────────────────────────────────────

const stubAuthClient: AtlasAuthClient = {
  signIn: { email: async () => ({}) },
  signUp: { email: async () => ({}) },
  signOut: async () => {},
  useSession: () => ({ data: null, isPending: false }),
};

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(AtlasProvider, {
      config: {
        apiUrl: "http://localhost:3001",
        isCrossOrigin: false as const,
        authClient: stubAuthClient,
      },
      children,
    }),
  );
}

function renderSaas(status: SandboxStatus) {
  return render(
    createElement(SaasSandboxView, {
      status,
      onSelectBackend: mock(async (_backendId: string) => undefined),
      onSelectManaged: mock(async () => undefined),
      onRefetch: mock(() => {}),
      saving: false,
    }),
    { wrapper },
  );
}

function renderSelfHosted(status: SandboxStatus) {
  stagedStatus = status;
  return render(
    createElement(SelfHostedSandboxView, {
      onSelectBackend: mock(async (_backendId: string) => undefined),
      onSetSidecarUrl: mock(async (_url: string) => undefined),
      onReset: mock(async () => {}),
      saving: false,
    }),
    { wrapper },
  );
}

// House convention, and load-bearing here: RTL binds queries to `document.body`,
// so a test that throws before an inline `cleanup()` leaks DOM into the next one.
afterEach(() => {
  cleanup();
});

// ── SaaS view ─────────────────────────────────────────────────────

describe("SaasSandboxView — fail-closed region (#4837)", () => {
  test("the managed card reads Down, never Live, when the platform default failed closed", () => {
    const { getByText, queryByText } = renderSaas(failClosedStatus());

    getByText("Down");
    // The regression: "Live" on a region where explore refuses every request.
    expect(queryByText("Live")).toBeNull();
    // "Available" would be just as wrong — it is not available, it is broken.
    expect(queryByText("Available")).toBeNull();
  });

  test("offers no 'Use this' on the managed card — selecting the broken default is not a fix", () => {
    const { queryAllByText } = renderSaas(failClosedStatus());
    expect(queryAllByText("Use this").length).toBe(0);
  });

  test("POSITIVE CONTROL — 'Use this' is the real label, so the assertion above can fail", () => {
    // Without this, `length === 0` would also pass if the button were renamed,
    // restyled, or deleted outright. Here the managed card is NOT selected (a
    // BYOC row is live), so the button must be present.
    const { queryAllByText } = renderSaas(
      healthyStatus({
        activeBackend: "e2b-sandbox",
        workspaceOverride: "e2b-sandbox",
        connectedProviders: [
          {
            provider: "e2b",
            displayName: "Acme",
            connectedAt: "2026-06-01T00:00:00.000Z",
            validatedAt: null,
            isActive: true,
          },
        ],
      }),
    );
    expect(queryAllByText("Use this").length).toBeGreaterThan(0);
  });

  test("a healthy region is unchanged — the managed card still reads Live", () => {
    // Guards the other direction: the Down state must be gated on the outage,
    // not accidentally on "no BYOC provider is live", which is the normal case.
    const { getByText, queryByText } = renderSaas(healthyStatus());
    getByText("Live");
    expect(queryByText("Down")).toBeNull();
  });

  test("a usable BYOC override keeps running — the managed card is not marked down", () => {
    // The override sits ahead of the platform plan, so this workspace's explore
    // still works. Flagging it down would be a false alarm, and an operator who
    // learns to dismiss one alarm dismisses the next.
    const { queryByText } = renderSaas(
      failClosedStatus({
        activeBackend: "e2b-sandbox",
        workspaceOverride: "e2b-sandbox",
        connectedProviders: [
          {
            provider: "e2b",
            displayName: "Acme",
            connectedAt: "2026-06-01T00:00:00.000Z",
            validatedAt: null,
            isActive: true,
          },
        ],
      }),
    );
    expect(queryByText("Down")).toBeNull();
  });
});

// ── Self-hosted view — the row the issue is named after ────────────

describe("SelfHostedSandboxView — fail-closed deployment (#4837)", () => {
  test("the Active row says explore refuses requests instead of showing an id", () => {
    const { getByText, queryByText } = renderSelfHosted(failClosedStatus());

    getByText(/None — explore refuses every request/);
    // The literal regression: the sentinel rendered as a backend id.
    expect(queryByText("fail-closed")).toBeNull();
  });

  test("never interpolates a bare 'null' into the platform-default copy", () => {
    // `DetailRow.value` is `ReactNode` and template literals stringify `null`,
    // so the nullable type ALONE would have shipped a blank row and a literal
    // "Using the platform default (null)." — the same class of bug in new words.
    // This is what the schema docblock means by "the compiler does not catch
    // consumers that swallow null".
    const { queryByText, container } = renderSelfHosted(failClosedStatus());
    expect(queryByText(/\(null\)/)).toBeNull();
    expect(container.textContent).not.toContain("null");
  });

  test("the status pill reads Down, outranking Override/Default", () => {
    const { getByText, queryByText } = renderSelfHosted(failClosedStatus());
    getByText("Down");
    // "Default" describes which knob is in effect — not the operator's problem
    // when nothing runs at all.
    expect(queryByText("Default")).toBeNull();
  });

  test("a healthy deployment still shows the backend id in the Active row", () => {
    // Positive control for the three above: proves the outage copy is gated on
    // the outage rather than always rendered.
    const { getAllByText, queryByText } = renderSelfHosted(healthyStatus());
    expect(getAllByText("vercel-sandbox").length).toBeGreaterThan(0);
    expect(queryByText(/None — explore refuses every request/)).toBeNull();
    expect(queryByText("Down")).toBeNull();
  });
});

// ── Outage banner ─────────────────────────────────────────────────

describe("SandboxOutageNotice — remediation (#4837)", () => {
  test("renders the server's remediation verbatim, naming the pin and its credential", () => {
    const { getByRole, getByText } = render(
      createElement(SandboxOutageNotice, {
        remediation: REMEDIATION,
        workspaceStillRunning: false,
      }),
      { wrapper },
    );

    getByRole("alert");
    getByText(/every request is refused/);
    // The AC that separates this from #4828: the operator is told which backend
    // is pinned and which credential it needs — not "install nsjail", which the
    // pin makes impossible to act on.
    getByText(/vercel-sandbox/);
    getByText(/VERCEL_TOKEN/);
  });

  test("softens the headline when a workspace BYOC backend is still running", () => {
    const { getByText, queryByText } = render(
      createElement(SandboxOutageNotice, {
        remediation: REMEDIATION,
        workspaceStillRunning: true,
      }),
      { wrapper },
    );

    getByText(/this workspace is running on its own backend/i);
    // A blanket "every request is refused" here would be a false alarm for a
    // workspace whose explore demonstrably works.
    expect(queryByText("Explore tool unavailable — every request is refused")).toBeNull();
  });

  test("still raises the alarm when the remediation is missing", () => {
    // Losing the remediation must never downgrade the reported state. The
    // headline is driven by the outage, not by the string, so a payload without
    // a `failClosed` block still shows the outage — it just cannot say how to
    // fix it. The presentation-layer half of that principle.
    const { getByRole, getByText } = render(
      createElement(SandboxOutageNotice, {
        remediation: null,
        workspaceStillRunning: false,
      }),
      { wrapper },
    );

    getByRole("alert");
    getByText(/every request is refused/);
    getByText(/No remediation was reported/);
  });
});
