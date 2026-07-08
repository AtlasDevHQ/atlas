/**
 * Coverage for the Agent Auth device-approval page (#4411).
 *
 * Pins the browser round-trip: render the pending capability request, POST the
 * user's decision to `/agent/approve-capability` with the right body, and render
 * the terminal state. Also pins the fail-closed gate (404 → "not available"),
 * the not-signed-in login bounce, and the expired/handled ("no pending request")
 * path.
 *
 * `mock.module(...)` covers every named export it stubs (repo rule) so a sibling
 * test importing a different export doesn't trip a partial-mock error.
 */

import {
  describe,
  expect,
  test,
  mock,
  beforeEach,
  afterEach,
} from "bun:test";
import {
  render,
  fireEvent,
  waitFor,
  cleanup,
  screen,
} from "@testing-library/react";

// ── Mocks ───────────────────────────────────────────────────────────────

type Session = {
  isPending: boolean;
  data: { user: { id: string; email: string } } | null;
};
const sessionStore: { value: Session } = {
  value: { isPending: false, data: { user: { id: "user_1", email: "dev@useatlas.dev" } } },
};

mock.module("@/lib/auth/client", () => ({
  authClient: {
    useSession: () => sessionStore.value,
  },
}));

const searchParamsStore: Record<string, string | null> = {
  agent_id: "agent_1",
  code: "ABCD-2345",
};
mock.module("next/navigation", () => ({
  useSearchParams: () => ({ get: (k: string) => searchParamsStore[k] ?? null }),
}));

// Spread the real module so every named export stays present (repo rule),
// overriding only `getApiUrl` to a fixed cross-origin API host.
import * as apiUrlReal from "@/lib/api-url";
mock.module("@/lib/api-url", () => ({
  ...apiUrlReal,
  getApiUrl: () => "https://api.useatlas.dev",
}));

import AgentApprovePage from "./page";

// ── fetch stub ──────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}
const fetchCalls: FetchCall[] = [];

/** Response the pending-list GET returns; overridable per test. */
let pendingResponder: () => Response = () =>
  jsonResponse(200, {
    requests: [
      {
        approval_id: "appr_1",
        method: "device_authorization",
        agent_id: "agent_1",
        agent_name: "Reporting Agent",
        binding_message: "Weekly revenue report",
        capabilities: ["getMe"],
        capability_reasons: { getMe: "Identify the caller" },
        expires_in: 300,
      },
    ],
  });
/** Response the approve/deny POST returns; overridable per test. */
let approveResponder: () => Response = () => jsonResponse(200, { status: "approved" });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls.length = 0;
  sessionStore.value = {
    isPending: false,
    data: { user: { id: "user_1", email: "dev@useatlas.dev" } },
  };
  searchParamsStore.agent_id = "agent_1";
  searchParamsStore.code = "ABCD-2345";
  pendingResponder = () =>
    jsonResponse(200, {
      requests: [
        {
          approval_id: "appr_1",
          method: "device_authorization",
          agent_id: "agent_1",
          agent_name: "Reporting Agent",
          binding_message: "Weekly revenue report",
          capabilities: ["getMe"],
          capability_reasons: { getMe: "Identify the caller" },
          expires_in: 300,
        },
      ],
    });
  approveResponder = () => jsonResponse(200, { status: "approved" });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    fetchCalls.push({ url, method, body });
    if (url.includes("/agent/approve-capability")) return approveResponder();
    if (url.includes("/agent/ciba/pending")) return pendingResponder();
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("agent approval page (#4411)", () => {
  test("renders the pending capability request for the signed-in user", async () => {
    render(<AgentApprovePage />);
    await waitFor(() => expect(screen.getByText("Reporting Agent")).toBeDefined());
    expect(screen.getByText("Weekly revenue report")).toBeDefined();
    expect(screen.getByText("getMe")).toBeDefined();
    expect(screen.getByText("dev@useatlas.dev")).toBeDefined();
    // The pending list was fetched with the credentialed GET.
    expect(fetchCalls.some((c) => c.url.includes("/agent/ciba/pending") && c.method === "GET")).toBe(
      true,
    );
  });

  test("approve POSTs action:approve with the user code, then shows approved", async () => {
    render(<AgentApprovePage />);
    await waitFor(() => expect(screen.getByText("Approve")).toBeDefined());
    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() => expect(screen.getByText("Capability approved")).toBeDefined());
    const post = fetchCalls.find((c) => c.url.includes("/agent/approve-capability"));
    expect(post).toBeDefined();
    expect(post?.method).toBe("POST");
    expect(post?.body).toEqual({ agent_id: "agent_1", user_code: "ABCD-2345", action: "approve" });
  });

  test("deny POSTs action:deny and shows the denied terminal state", async () => {
    approveResponder = () => jsonResponse(200, { status: "denied" });
    render(<AgentApprovePage />);
    await waitFor(() => expect(screen.getByText("Deny")).toBeDefined());
    fireEvent.click(screen.getByText("Deny"));

    await waitFor(() => expect(screen.getByText("Request denied")).toBeDefined());
    const post = fetchCalls.find((c) => c.url.includes("/agent/approve-capability"));
    expect(post?.body).toEqual({ agent_id: "agent_1", user_code: "ABCD-2345", action: "deny" });
  });

  test("a rejected decision surfaces the server message and stays on the form", async () => {
    approveResponder = () =>
      jsonResponse(403, { error: "invalid_user_code", message: "That code is invalid or expired." });
    render(<AgentApprovePage />);
    await waitFor(() => expect(screen.getByText("Approve")).toBeDefined());
    fireEvent.click(screen.getByText("Approve"));

    await waitFor(() =>
      expect(screen.getByText("That code is invalid or expired.")).toBeDefined(),
    );
    // Not a false success — the form is still shown.
    expect(screen.getByText("Approve")).toBeDefined();
  });

  test("404 on the pending list → the fail-closed 'not available' state (gate off)", async () => {
    pendingResponder = () => jsonResponse(404, { error: "not_found" });
    render(<AgentApprovePage />);
    await waitFor(() =>
      expect(screen.getByText("Agent approvals are not available")).toBeDefined(),
    );
    // No approve control is offered when the surface is gated off.
    expect(screen.queryByText("Approve")).toBeNull();
  });

  test("POST-time gate 404 (surface toggled off mid-flow) → 'not available'", async () => {
    approveResponder = () => jsonResponse(404, { error: "not_found" });
    render(<AgentApprovePage />);
    await waitFor(() => expect(screen.getByText("Approve")).toBeDefined());
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() =>
      expect(screen.getByText("Agent approvals are not available")).toBeDefined(),
    );
  });

  test("POST-time stale-agent 404 → an error message, NOT the 'not available' screen", async () => {
    approveResponder = () =>
      jsonResponse(404, { error: "agent_not_found", message: "This agent was revoked." });
    render(<AgentApprovePage />);
    await waitFor(() => expect(screen.getByText("Approve")).toBeDefined());
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(screen.getByText("This agent was revoked.")).toBeDefined());
    // Not mislabeled as the feature being disabled.
    expect(screen.queryByText("Agent approvals are not available")).toBeNull();
    // Still on the form so the user can retry with a fresh link.
    expect(screen.getByText("Approve")).toBeDefined();
  });

  test("no matching pending request → the expired/handled state", async () => {
    pendingResponder = () => jsonResponse(200, { requests: [] });
    render(<AgentApprovePage />);
    await waitFor(() => expect(screen.getByText("No pending request")).toBeDefined());
  });

  test("not signed in → bounce to login carrying a redirect back to this URL", () => {
    sessionStore.value = { isPending: false, data: null };
    render(<AgentApprovePage />);
    const signIn = screen.getByText("Sign in").closest("a");
    expect(signIn?.getAttribute("href")).toContain("/login?redirect=");
    expect(decodeURIComponent(signIn?.getAttribute("href") ?? "")).toContain(
      "/agent/approve?agent_id=agent_1&code=ABCD-2345",
    );
    // No agent-auth call is made until the user is signed in.
    expect(fetchCalls.length).toBe(0);
  });

  test("missing agent_id/code → an actionable 'open from your agent' state", async () => {
    searchParamsStore.agent_id = null;
    render(<AgentApprovePage />);
    await waitFor(() => expect(screen.getByText("Open this from your agent")).toBeDefined());
    expect(fetchCalls.length).toBe(0);
  });
});
