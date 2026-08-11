/**
 * `atlas query` command-core auth-parity tests (#4124).
 *
 * Exercises the testable `runQueryCommand` core with an injected session,
 * api-key, base URL, and stub `fetch` — no live server. Pins the credential
 * resolution at PARITY with `atlas sql` (the regression #4124 fixed):
 *  - a logged-in `atlas login` SESSION authenticates with NO key needed, sent
 *    as `Authorization: Bearer <token>` (the old code ignored the session);
 *  - a workspace API KEY (`--api-key` / `ATLAS_API_KEY`) rides `x-api-key`, the
 *    Better Auth `apiKey()` plugin's header — NEVER `Authorization: Bearer`
 *    (the old code sent keys as a Bearer, so the server rejected them);
 *  - a key wins over a session (unattended CI never goes through `atlas login`);
 *  - no credential at all → an actionable "log in or set ATLAS_API_KEY" error.
 * Plus the request shape (POST /api/v1/query, body carries question [+ optional
 * connectionId]) and the json/csv guards.
 */

import { describe, it, expect } from "bun:test";

import {
  runQueryCommand,
  type QueryIO,
  type QueryRunDeps,
} from "../commands/query";
import type { StoredSession } from "../lib/credentials";

const BASE = "http://localhost:3001";
const SESSION: StoredSession = {
  token: "sess_abc",
  workspaceId: "org-1",
  createdAt: "2026-06-29T00:00:00Z",
};

const OK_RESPONSE = {
  answer: "There are 42 users.",
  sql: ["SELECT COUNT(*) FROM users"],
  data: [{ columns: ["count"], rows: [{ count: 42 }] }],
  steps: 1,
  usage: { totalTokens: 150 },
};

function capture(): { io: QueryIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

/** Single-canned-response fetch capturing requests + their bodies + headers. */
function stubFetch(
  status: number,
  body: unknown,
): {
  fetchImpl: typeof fetch;
  calls: Array<{ method: string; url: string; body: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ method: string; url: string; body: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers as Record<string, string>).forEach((v, k) => {
        headers[k] = v;
      });
    }
    calls.push({
      method: init?.method ?? "GET",
      url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url,
      body: typeof init?.body === "string" ? init.body : "",
      headers,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function deps(
  fetchImpl: typeof fetch | undefined,
  overrides: Partial<QueryRunDeps> = {},
): QueryRunDeps {
  return {
    baseUrl: BASE,
    session: SESSION,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    ...overrides,
  };
}

describe("runQueryCommand — guards", () => {
  it("with no credential (no session, no key), refuses with a login hint and exits 1", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_RESPONSE);
    const { io, err } = capture();
    const code = await runQueryCommand(
      ["query", "how many users?"],
      deps(fetchImpl, { session: null }),
      io,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("atlas login");
    expect(err.join("\n")).toContain("ATLAS_API_KEY");
    // No request should have gone out without a credential.
    expect(calls).toHaveLength(0);
  });

  it("no question positional prints usage and exits 1", async () => {
    const { io, err } = capture();
    const code = await runQueryCommand(["query"], deps(undefined), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain('atlas query "your question"');
  });

  it("--json and --csv together are rejected", async () => {
    const { io, err } = capture();
    const code = await runQueryCommand(
      ["query", "q", "--json", "--csv"],
      deps(undefined),
      io,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("mutually exclusive");
  });
});

describe("runQueryCommand — credential parity with `atlas sql` (#4124)", () => {
  it("authenticates a logged-in session with Authorization: Bearer (no key needed)", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_RESPONSE);
    const { io } = capture();
    const code = await runQueryCommand(["query", "how many users?"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["authorization"]).toBe("Bearer sess_abc");
    // A session must NOT be sent as an api key.
    expect(calls[0].headers["x-api-key"]).toBeUndefined();
  });

  it("sends a workspace API key via x-api-key, NOT Authorization (the #4124 bug)", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_RESPONSE);
    const { io } = capture();
    const code = await runQueryCommand(
      ["query", "how many users?", "--api-key", "atlas_key_xyz"],
      deps(fetchImpl, { session: null }),
      io,
    );
    expect(code).toBe(0);
    expect(calls[0].headers["x-api-key"]).toBe("atlas_key_xyz");
    expect(calls[0].headers["authorization"]).toBeUndefined();
  });

  it("reads ATLAS_API_KEY (deps.apiKey) and rides x-api-key", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_RESPONSE);
    const { io } = capture();
    const code = await runQueryCommand(
      ["query", "how many users?"],
      deps(fetchImpl, { session: null, apiKey: "atlas_env_key" }),
      io,
    );
    expect(code).toBe(0);
    expect(calls[0].headers["x-api-key"]).toBe("atlas_env_key");
    expect(calls[0].headers["authorization"]).toBeUndefined();
  });

  it("a --api-key flag wins over both ATLAS_API_KEY and a stored session", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_RESPONSE);
    const { io } = capture();
    const code = await runQueryCommand(
      ["query", "how many users?", "--api-key", "flag_key"],
      deps(fetchImpl, { apiKey: "env_key" }),
      io,
    );
    expect(code).toBe(0);
    expect(calls[0].headers["x-api-key"]).toBe("flag_key");
    expect(calls[0].headers["authorization"]).toBeUndefined();
  });
});

describe("runQueryCommand — request shape", () => {
  it("POSTs to /api/v1/query with the question in the body", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_RESPONSE);
    const { io } = capture();
    const code = await runQueryCommand(["query", "top 5 customers"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/api/v1/query`);
    expect(JSON.parse(calls[0].body)).toEqual({ question: "top 5 customers" });
  });

  it("threads --connection into the request body (and not the question positional)", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_RESPONSE);
    const { io } = capture();
    const code = await runQueryCommand(
      ["query", "top categories", "--connection", "warehouse"],
      deps(fetchImpl),
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(calls[0].body)).toEqual({
      question: "top categories",
      connectionId: "warehouse",
    });
  });

  it("does not mistake the --api-key value for the question positional", async () => {
    const { fetchImpl, calls } = stubFetch(200, OK_RESPONSE);
    const { io } = capture();
    const code = await runQueryCommand(
      ["query", "--api-key", "atlas_key", "real question"],
      deps(fetchImpl, { session: null }),
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(calls[0].body)).toEqual({ question: "real question" });
    expect(calls[0].headers["x-api-key"]).toBe("atlas_key");
  });

  it("renders --json as the raw response and exits 0", async () => {
    const { fetchImpl } = stubFetch(200, OK_RESPONSE);
    const { io, out } = capture();
    const code = await runQueryCommand(["query", "q", "--json"], deps(fetchImpl), io);
    expect(code).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ answer: "There are 42 users." });
  });
});

describe("runQueryCommand — auto-approve credential propagation (#4124 seam)", () => {
  // The action-approval POST carries the SAME regression surface as the query
  // request: a key sent as `Authorization: Bearer` is server-rejected. Pin that
  // the credential resolved for the query is threaded into the approval call too.
  const RESPONSE_WITH_PENDING = {
    answer: "I need your approval to send a notification.",
    sql: [],
    data: [],
    steps: 1,
    usage: { totalTokens: 10 },
    pendingActions: [
      {
        id: "act-1",
        type: "notification",
        target: "#revenue",
        summary: "Send notification to #revenue",
        approveUrl: "http://localhost:3001/api/v1/actions/act-1/approve",
        denyUrl: "http://localhost:3001/api/v1/actions/act-1/deny",
      },
    ],
    // Consumed by the approval POST's response (handleActionApproval reads `status`).
    status: "approved",
  };

  it("propagates a SESSION into the auto-approved action POST (Authorization: Bearer)", async () => {
    const { fetchImpl, calls } = stubFetch(200, RESPONSE_WITH_PENDING);
    const { io } = capture();
    const code = await runQueryCommand(
      ["query", "notify #revenue", "--auto-approve"],
      deps(fetchImpl),
      io,
    );
    expect(code).toBe(0);
    // calls[0] = POST /query, calls[1] = POST the action approveUrl.
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("http://localhost:3001/api/v1/actions/act-1/approve");
    expect(calls[1].headers["authorization"]).toBe("Bearer sess_abc");
    expect(calls[1].headers["x-api-key"]).toBeUndefined();
  });

  it("propagates a workspace API KEY into the auto-approved action POST (x-api-key, not Bearer)", async () => {
    const { fetchImpl, calls } = stubFetch(200, RESPONSE_WITH_PENDING);
    const { io } = capture();
    const code = await runQueryCommand(
      ["query", "notify #revenue", "--auto-approve", "--api-key", "atlas_key_xyz"],
      deps(fetchImpl, { session: null }),
      io,
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers["x-api-key"]).toBe("atlas_key_xyz");
    expect(calls[1].headers["authorization"]).toBeUndefined();
  });
});

describe("runQueryCommand — HTTP error handling", () => {
  it("maps a 401 to an actionable auth-failed message and exits 1", async () => {
    const { fetchImpl } = stubFetch(401, { error: "auth_error", message: "Not signed in" });
    const { io, err } = capture();
    const code = await runQueryCommand(["query", "q"], deps(fetchImpl), io);
    expect(code).toBe(1);
    const text = err.join("\n");
    expect(text).toContain("Authentication failed");
    expect(text).toContain("atlas login");
  });
});

/**
 * `atlas query --json` / `--csv`: stdout parses, on EVERY path (#5146).
 *
 * ⚠️ THE WRITER FIXED HERE IS ON AN ERROR PATH, AND THAT IS WHY READING THE
 * DRIVER MISSED IT. A note in `bin/eval-log-destination.ts` recorded — as a
 * verified fact — that the logger was this command's ONLY fd-1 polluter. It was
 * arrived at by reading the success path, where the claim holds. The
 * unexpected-response branch returns BEFORE the `--json` body runs and echoed
 * `data.answer` to `io.out`, so a version-skewed server made
 * `atlas query --json` emit bare prose on fd 1 and nothing else.
 *
 * #5126's own defect was a third writer nobody counted. Count them by
 * EXECUTION — which is what driving the real core with a stub response does.
 */
describe("runQueryCommand — stdout is a machine channel under --json/--csv", () => {
  // `data` is not an array, so the runtime shape check rejects it. `answer` is
  // present because that is the field the branch echoes; without it the branch
  // is reached and writes nothing, and the test would pass against the defect.
  const SKEWED_RESPONSE = {
    answer: "I found 42 users.",
    sql: [],
    data: { columns: [], rows: [] },
    steps: 1,
    usage: { totalTokens: 10 },
  };

  for (const flag of ["--json", "--csv"] as const) {
    it(`keeps the unexpected-response answer OFF stdout under ${flag}`, async () => {
      const { fetchImpl } = stubFetch(200, SKEWED_RESPONSE);
      const { io, out, err } = capture();
      const code = await runQueryCommand(
        ["query", "how many users?", flag],
        deps(fetchImpl),
        io,
      );
      expect(code).toBe(1);
      // Empty, not "parses" — nothing at all is the only stdout a failed run can
      // put in a pipe without corrupting it, since neither JSON nor CSV has a
      // representation for "this went wrong".
      expect(out).toEqual([]);
      // ⚠️ ASSERTED, NOT ASSUMED: redirecting must not DROP the answer. A fix
      // that deleted the echo passes the line above and loses the one piece of
      // diagnostic the failed response carried.
      expect(err.join("\n")).toContain("I found 42 users.");
    });
  }

  it("still echoes the answer on STDOUT in human mode", () => {
    // The other direction. Human mode is not piped, the answer is the useful
    // part of a failed response, and a fix that sent everything to fd 2
    // unconditionally would pass every assertion above.
    const { fetchImpl } = stubFetch(200, SKEWED_RESPONSE);
    const { io, out } = capture();
    return runQueryCommand(["query", "how many users?"], deps(fetchImpl), io).then((code) => {
      expect(code).toBe(1);
      expect(out.join("\n")).toContain("I found 42 users.");
    });
  });
});
