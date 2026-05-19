/**
 * E2E: Plugin-webhook (chat-interaction) surface.
 *
 * #2633 — closes the integration-test gap left by slice 3 of the
 * proactive-listener wiring trail (parent #2607). Slice 3 (PR #2626)
 * migrated Slack `app_mention` + thread-followup from
 * `packages/api/src/api/routes/slack.ts` to the `@useatlas/chat` plugin
 * webhook (`/api/plugins/chat-interaction/webhooks/slack`). Slack APIs
 * are stubbed via the same `mock-server.ts` + patched `fetch` pattern as
 * the legacy `slack.test.ts` surface; the host helper unit tests in
 * `packages/api/src/lib/chat-plugin/__tests__/execute-query.test.ts` pin
 * envelope shape in isolation — this surface drives the full chain end
 * to end:
 *
 *   Slack-signed request
 *     → chat-interaction webhook route
 *     → Slack adapter signature verify + event parse
 *     → bridge `onNewMention` / proactive `onNewMessage` handler
 *     → host `executeQuery` / proactive meter callback
 *     → Slack API stub (chat.postMessage / reactions.add)
 *
 * Three behaviors covered (one each per AC bullet in the issue):
 *
 *   1. `app_mention` envelope parity — answer text + `thread_ts` + the
 *      `:lock:` notice when the agent reports `pendingApproval` — matches
 *      the pre-#2626 envelope `slack.ts` produced.
 *
 *   2. Proactive happy path — a `message` event in a channel allowlisted
 *      via `channel_proactive_config` triggers a 🤖 react path. Verified
 *      via the `onMeterEvent` callback (a `react` row lands), which is
 *      the same surface the production host wires to
 *      `proactive_meter_events` writes — i.e. dogfood-equivalent.
 *
 *   3. Three-layer kill switch — workspace toggle off / `proactive_pauses`
 *      row / DM `unsubscribe` — each short-circuits before classification
 *      so no `react` meter row lands. The two PRs that escaped slice 3's
 *      unit + boot-smoke coverage (#2628, #2630) would have failed *this*
 *      surface — both bugs flipped a host-supplied gate (channel-allow,
 *      bot-token presence) into a mode where the proactive path silently
 *      misbehaved on a real Slack event.
 *
 * Plugin webhook only — the legacy `/api/v1/slack/*` slash + interaction
 * paths stay covered by `slack.test.ts`.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
  type Mock,
} from "bun:test";
import { makeSignature } from "../helpers/slack-helpers";

// ---------------------------------------------------------------------------
// Stub @slack/web-api at the module boundary.
//
// `@chat-adapter/slack` constructs a `WebClient` from `@slack/web-api` and
// uses it for every Slack API call (chat.postMessage, users.info,
// conversations.info, reactions.add, …). The web-api SDK is axios-backed,
// so a `globalThis.fetch` patch (the trick used by `slack.test.ts` for the
// legacy `/api/v1/slack/*` path, which calls `fetch` directly) doesn't
// intercept it — real network calls would land on Slack, get
// `invalid_auth` from our fake test token, and stall the dispatch path
// for hundreds of ms per parsed message. Stubbing here keeps the
// surface in-process, fast, and offline-safe.
//
// Returned responses are minimum-viable shapes the SDK + adapter both
// accept (`ok: true` + the few fields the adapter actually reads).
// ---------------------------------------------------------------------------
class StubWebClient {
  // The adapter accesses `client.chat`, `client.users`, etc. as nested
  // namespaces. Each maps to an async function returning the minimum
  // shape the SDK accepts (`ok: true` + a handful of fields the
  // adapter actually reads). Anything missed here surfaces as a
  // `WebAPIPlatformError` at the adapter, which fails closed — surface
  // it in tests rather than silently hitting prod.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chat = {
    postMessage: async (args: { channel: string; thread_ts?: string }) =>
      stubWebClientPostCalls.push({ method: "chat.postMessage", args }) &&
      Promise.resolve({ ok: true, ts: "9999999999.000099", channel: args.channel }),
    update: async () => Promise.resolve({ ok: true }),
    postEphemeral: async () => Promise.resolve({ ok: true }),
  } as const;
  users = {
    info: async (args: { user: string }) =>
      Promise.resolve({
        ok: true,
        user: { id: args.user, name: args.user, real_name: args.user },
      }),
  } as const;
  conversations = {
    info: async (args: { channel: string }) =>
      Promise.resolve({ ok: true, channel: { id: args.channel, name: args.channel } }),
    history: async () => Promise.resolve({ ok: true, messages: [] }),
    replies: async () => Promise.resolve({ ok: true, messages: [] }),
    open: async () => Promise.resolve({ ok: true, channel: { id: "D_OPENED" } }),
  } as const;
  reactions = {
    add: async () => Promise.resolve({ ok: true }),
    remove: async () => Promise.resolve({ ok: true }),
  } as const;
  views = {
    open: async () => Promise.resolve({ ok: true, view: { id: "V_TEST" } }),
    update: async () => Promise.resolve({ ok: true }),
  } as const;
  auth = {
    test: async () =>
      Promise.resolve({ ok: true, user_id: "U_BOT", bot_id: "B_BOT", user: "atlas-bot" }),
  } as const;
  // The adapter passes a request interceptor to axios; the stub ignores
  // it. Listed here for completeness so a feature add doesn't blow up
  // construction.
  interceptors = { request: { use: () => {} }, response: { use: () => {} } };
  apiCall = async () => Promise.resolve({ ok: true });
}

const stubWebClientPostCalls: Array<{ method: string; args: unknown }> = [];

mock.module("@slack/web-api", () => ({
  WebClient: StubWebClient,
  LogLevel: { DEBUG: "DEBUG", INFO: "INFO", WARN: "WARN", ERROR: "ERROR" },
  ErrorCode: {},
}));

// ---------------------------------------------------------------------------
// Minimal Hono-compatible router shim.
//
// The chat plugin registers webhook routes by calling `app.post(path, handler)`
// — when the host is `@atlas/api`, `app` is a real Hono instance. The e2e
// surface lives at the repo root and never imports `@atlas/api`, so the
// transitive `hono` install in `packages/api/node_modules/` isn't on the
// resolver path. A 30-line in-test router avoids a workspace dependency
// (which would tug at every Deploy Validation matrix job) and keeps the
// surface focused on the plugin webhook contract.
//
// Surface tested: signature verify + event dispatch + bridge handlers +
// host callbacks + Slack API stub. The 5-line route wrapper itself
// (503 / 404 guards + correlation-id error mapping) is covered by the
// bridge.test.ts lifecycle suite — replicating it here adds nothing.
// ---------------------------------------------------------------------------
type ShimHandler = (c: ShimContext) => Promise<Response> | Response;
interface ShimContext {
  req: { raw: Request; query: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
  html: (body: string, status?: number) => Response;
  redirect: (url: string, status?: number) => Response;
}
class RouterShim {
  private readonly routes = new Map<string, ShimHandler>();
  post(path: string, handler: ShimHandler): void {
    this.routes.set(`POST ${path}`, handler);
  }
  get(path: string, handler: ShimHandler): void {
    this.routes.set(`GET ${path}`, handler);
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const handler = this.routes.get(`${req.method} ${url.pathname}`);
    if (!handler) return new Response("not found", { status: 404 });
    const ctx: ShimContext = {
      req: {
        raw: req,
        query: (name: string) => url.searchParams.get(name) ?? undefined,
      },
      json: (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      html: (body, status = 200) =>
        new Response(body, {
          status,
          headers: { "Content-Type": "text/html" },
        }),
      redirect: (url, status = 302) =>
        new Response(null, { status, headers: { Location: url } }),
    };
    return handler(ctx);
  }
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SIGNING_SECRET = "test-signing-secret-for-proactive-e2e";
// SlackAdapter operates in single-workspace mode when `botToken` is set;
// multi-workspace mode (no botToken) would otherwise require an installation
// lookup before the adapter will route events. The plugin's
// `SlackAdapterConfig` wrapper doesn't surface `botUserId` — the adapter
// fetches it lazily via `auth.test()` when missing (the StubWebClient at
// the top of this file returns one).
const BOT_TOKEN = "xoxb-test-token-proactive";
const TEAM_ID = "T_TEST_TEAM";
const CHANNEL_ID = "C_ALLOWLISTED";
const DM_CHANNEL_ID = "D_DM_CHANNEL";
const USER_ID = "U_ASKER";
const WORKSPACE_ID = "ws-test";
const DISABLED_WORKSPACE_ID = "ws-disabled";
const PAUSED_WORKSPACE_ID = "ws-paused";

// ---------------------------------------------------------------------------
// Plugin / app setup — built once, behaviour controlled per-test via
// the host-supplied mocks below.
// ---------------------------------------------------------------------------

interface ExecuteQueryCall {
  question: string;
  adapterName?: string;
  rawMessage?: Record<string, unknown>;
  threadId: string;
}
const executeQueryCalls: ExecuteQueryCall[] = [];

let executeQueryReturn: {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
} = {
  answer: "There are 42 active users.",
  sql: ["SELECT COUNT(*) FROM users"],
  data: [{ columns: ["count"], rows: [{ count: 42 }] }],
  steps: 1,
  usage: { totalTokens: 100 },
};

// The plugin's ChatExecuteQueryContext / ResolveWorkspaceIdFn / etc.
// types are pulled from `chat` and `@useatlas/chat`. The host-supplied
// callbacks accept those concrete shapes; for tests we narrow what the
// callback body actually touches and let `as never`-style casts on the
// config object placate the strict checker. Avoids importing the full
// type surface of `chat` into the e2e directory just for type tags.
const mockExecuteQuery = mock(
  async (
    question: string,
    ctx: {
      threadId: string;
      adapter: { name: string };
      rawMessage?: unknown;
      priorMessages?: unknown;
    },
  ) => {
    executeQueryCalls.push({
      question,
      adapterName: ctx.adapter.name,
      rawMessage: (ctx.rawMessage ?? undefined) as Record<string, unknown> | undefined,
      threadId: ctx.threadId,
    });
    return executeQueryReturn;
  },
);

interface MeterEvent {
  workspaceId: string;
  channelId: string;
  eventType: string;
  metadata?: Record<string, unknown>;
}
const meterEvents: MeterEvent[] = [];
const mockMeterEvent: Mock<(e: MeterEvent) => Promise<void>> = mock(async (e) => {
  meterEvents.push(e);
});

interface PauseRequest {
  workspaceId: string;
  channelId: string | null;
  userId: string;
  layer: string;
  durationMs: number | null;
  requestedAt: number;
}
const pauseRequests: PauseRequest[] = [];
const mockPauseRequest = mock(async (r: PauseRequest) => {
  pauseRequests.push(r);
});

// Host-supplied gate. Workspace `ws-disabled` is the kill switch
// (admin toggled proactive off) used by the kill-switch tests; the
// registration probe (`isEnabled("")`) must still succeed so the listener
// actually mounts.
const mockIsEnabled: Mock<(workspaceId: string) => Promise<boolean>> = mock(
  async (workspaceId: string) => workspaceId !== DISABLED_WORKSPACE_ID,
);

// Pause registry — `ws-paused` simulates an `proactive_pauses` row;
// every other workspace resolves to "not paused" so the happy-path test
// still emits a `react` row. `layer` returns a string typed as `PauseLayer`
// at call sites; we use `"admin-channel" as const` to satisfy the enum.
const mockIsPaused = mock(
  async (input: { workspaceId: string; channelId: string; userId?: string }) => {
    if (input.workspaceId === PAUSED_WORKSPACE_ID) {
      return { paused: true as const, layer: "admin-channel" as const };
    }
    return { paused: false as const };
  },
);

// LLM classifier stub — every passed text is a "real" question with
// high confidence. The proactive listener prefilter handles the
// non-question case before this fires.
const mockClassify = mock(async (_text: string) => ({
  isQuestion: true,
  confidence: 0.95,
}));

// Per-event workspace resolver — keyed off `event.team_id`. Each test
// overrides `currentWorkspaceId` to steer kill-switch branches. The
// listener passes a `{ adapter, thread, message }` event but our resolver
// only reads `message.raw.team_id` (matching the production Slack resolver).
let currentWorkspaceId: string = WORKSPACE_ID;
const mockResolveWorkspaceId = mock(async (event: { message: { raw?: unknown } }) => {
  const raw = event.message.raw as { team_id?: string } | undefined;
  const teamId = raw?.team_id;
  if (!teamId) return null;
  return currentWorkspaceId;
});

const mockGetWorkspaceConfig = mock(async (workspaceId: string) => ({
  workspaceId,
  enabled: true,
  sensitivity: "balanced" as const,
  classifierMode: "regex-prefilter" as const,
}));

const mockGetChannelConfigs = mock(async (_workspaceId: string) => [
  { channelId: CHANNEL_ID, allow: true as const },
]);

let app: RouterShim;
let teardown: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const { buildChatPlugin } = await import("../../plugins/chat/src/index");

  const plugin = buildChatPlugin({
    adapters: {
      slack: {
        botToken: BOT_TOKEN,
        signingSecret: SIGNING_SECRET,
      },
    },
    state: { backend: "memory" },
    // The plugin's `ChatExecuteQueryContext` / `ResolveWorkspaceIdFn` /
    // `OnPauseRequestFn` types pull from the broader Chat SDK type
    // surface; the mocks above narrow to what the bodies actually read,
    // so cast through `any` here rather than re-typing every callback
    // (`as never` would defeat the whole point of strict-mode coverage
    // for the e2e file's *own* code). Matches the pattern other workspace
    // tests use when stubbing a deep callback chain at the boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executeQuery: mockExecuteQuery as any,
    // Disable status reactions so the message-event flow does not race the
    // adapter's `reactions.add` calls into the test assertions.
    reactions: { enabled: false },
    proactive: {
      platform: "slack",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveWorkspaceId: mockResolveWorkspaceId as any,
      isEnabled: mockIsEnabled,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      classify: mockClassify as any,
      getWorkspaceConfig: mockGetWorkspaceConfig,
      getChannelConfigs: mockGetChannelConfigs,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isPaused: mockIsPaused as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onPauseRequest: mockPauseRequest as any,
      onMeterEvent: mockMeterEvent,
      // The user-resolver stub keeps every asker on the safe "unlinked"
      // branch — reaction-back behaviour is out of scope here (covered
      // by the answerer unit tests + #2624). We only need the react
      // meter row to fire to validate the channel-allowlist path.
      userResolver: async () => ({ atlasUserId: undefined }),
    },
  });

  await plugin.initialize!({
    db: null,
    connections: { get: () => { throw new Error("unused"); }, list: () => [] },
    tools: { register: () => {} },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    config: {},
  });

  // The bridge registers the proactive listener asynchronously
  // (`Promise.resolve().then(...)`); registration calls `isEnabled("")`
  // first, then synchronously wires `chat.onNewMessage(...)` and the
  // other handlers. Wait for the probe to land, then yield one extra
  // tick so the post-`await` handler-registration statements settle
  // before any webhook event arrives.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (mockIsEnabled.mock.calls.some((c) => c[0] === "")) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 100));

  // Plugin routes register relative to the plugin prefix; the shim
  // dispatches by full pathname, so we mount the routes onto a single
  // router and POST to the absolute path (`/webhooks/slack`).
  app = new RouterShim();
  plugin.routes!(app as unknown as Parameters<NonNullable<typeof plugin.routes>>[0]);

  teardown = async () => {
    if (plugin.teardown) await plugin.teardown();
  };
});

afterAll(async () => {
  if (teardown) await teardown();
});

beforeEach(() => {
  stubWebClientPostCalls.length = 0;
  executeQueryCalls.length = 0;
  meterEvents.length = 0;
  pauseRequests.length = 0;
  mockExecuteQuery.mockClear();
  mockMeterEvent.mockClear();
  mockPauseRequest.mockClear();
  mockClassify.mockClear();
  // Reset the per-test workspace id so a kill-switch test from earlier
  // doesn't leak into the next.
  currentWorkspaceId = WORKSPACE_ID;
  executeQueryReturn = {
    answer: "There are 42 active users.",
    sql: ["SELECT COUNT(*) FROM users"],
    data: [{ columns: ["count"], rows: [{ count: 42 }] }],
    steps: 1,
    usage: { totalTokens: 100 },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Plugin routes are mounted under `/api/plugins/${plugin.id}/...` when
// the host wires the plugin via `wireInteractionPlugins`. Here the shim
// hosts the unprefixed route directly — the path under test is the
// plugin's own `/webhooks/slack` registration.
const WEBHOOK_PATH = "/webhooks/slack";

function makeSignedEventRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  const { signature, timestamp } = makeSignature(SIGNING_SECRET, body);
  return new Request(`http://localhost${WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
}

async function waitFor(
  check: () => boolean,
  { timeout = 3000, interval = 10 } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!check()) throw new Error("waitFor timed out");
}

/**
 * Pause long enough for the listener to *not* fire — used by the
 * kill-switch tests to assert meter-row absence. The proactive handler
 * runs synchronously after `chat.processMessage` is called, but the
 * chat SDK queues messages onto an async dispatcher; we wait one
 * scheduler tick plus a small safety margin.
 */
async function waitForQuietPath(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: chat-interaction webhook — app_mention envelope parity (#2626 / #2607)", () => {
  it("posts a signed app_mention → executeQuery runs with adapter='slack' + raw event + reply text/thread_ts match pre-#2626 envelope", async () => {
    const eventTs = "1700000001.000100";
    const payload = {
      type: "event_callback",
      team_id: TEAM_ID,
      event: {
        type: "app_mention",
        team: TEAM_ID,
        team_id: TEAM_ID,
        user: USER_ID,
        channel: CHANNEL_ID,
        text: "<@U_BOT> how many active users?",
        ts: eventTs,
      },
    };

    const res = await app.fetch(makeSignedEventRequest(payload));
    expect(res.status).toBe(200);

    await waitFor(() => executeQueryCalls.length > 0);
    await waitFor(() =>
      stubWebClientPostCalls.some((c) => c.method === "chat.postMessage"),
    );

    expect(executeQueryCalls).toHaveLength(1);
    const call = executeQueryCalls[0]!;
    expect(call.adapterName).toBe("slack");
    // The raw event reaches the host helper so it can resolve tenancy —
    // matches the pre-#2626 slack.ts path and the `runExecuteQuery` unit
    // tests in chat-plugin/__tests__/execute-query.test.ts.
    expect(call.rawMessage).toBeDefined();
    expect(call.rawMessage!.team_id).toBe(TEAM_ID);
    expect(call.rawMessage!.user).toBe(USER_ID);
    expect(call.rawMessage!.channel).toBe(CHANNEL_ID);

    // Threaded reply envelope — the bridge posts `chat.postMessage`
    // with the answer text and a `thread_ts` pointing back at the
    // user's message (same as the legacy slack.ts:postMessage call).
    const postCalls = stubWebClientPostCalls.filter(
      (c) => c.method === "chat.postMessage",
    );
    expect(postCalls.length).toBeGreaterThan(0);
    const replyArgs = postCalls[postCalls.length - 1]!.args as {
      channel: string;
      text?: string;
      thread_ts?: string;
      blocks?: unknown[];
    };
    expect(replyArgs.channel).toBe(CHANNEL_ID);
    expect(replyArgs.thread_ts).toBe(eventTs);
    // Card flows through Block Kit, so the canonical answer text lands
    // in either `text` (fallback) or somewhere in the serialized blocks.
    const stringified = JSON.stringify(replyArgs);
    expect(stringified).toContain("42 active users");
  });

  it("approval-required path returns the canonical `:lock:` notice (parity with slack.ts pendingApproval branch)", async () => {
    executeQueryReturn = {
      answer:
        ":lock: This query requires approval before it can run. Rule: *PII-Read*. Approve via the Atlas admin console.",
      sql: [],
      data: [],
      steps: 0,
      usage: { totalTokens: 0 },
    };

    const eventTs = "1700000002.000200";
    const payload = {
      type: "event_callback",
      team_id: TEAM_ID,
      event: {
        type: "app_mention",
        team: TEAM_ID,
        team_id: TEAM_ID,
        user: USER_ID,
        channel: CHANNEL_ID,
        text: "<@U_BOT> show me PII",
        ts: eventTs,
      },
    };

    const res = await app.fetch(makeSignedEventRequest(payload));
    expect(res.status).toBe(200);

    await waitFor(() =>
      stubWebClientPostCalls.some((c) => c.method === "chat.postMessage"),
    );

    // The `:lock:` notice flows through the same card path as a normal
    // answer; the bridge renders it via `buildQueryResultCard` →
    // `formatQueryResponse`. Find it in the serialized args of any
    // chat.postMessage call the adapter made.
    const matched = stubWebClientPostCalls
      .filter((c) => c.method === "chat.postMessage")
      .map((c) => JSON.stringify(c.args))
      .find((b) => b.includes(":lock:"));
    expect(matched).toBeDefined();
    expect(matched).toContain("PII-Read");
  });

  it("url_verification challenge passes through the plugin webhook", async () => {
    const challenge = "abc123challengexyz";
    const payload = { type: "url_verification", challenge };
    const res = await app.fetch(makeSignedEventRequest(payload));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge: string };
    expect(json.challenge).toBe(challenge);
  });
});

describe("E2E: chat-interaction webhook — proactive react meter (#2607 slice trail)", () => {
  it("message in a channel allowlisted via channel_proactive_config emits an onMeterEvent with eventType='react' (the bug #2628 would have surfaced)", async () => {
    // A non-mention message. The bridge's onNewMention will NOT fire;
    // the proactive listener's onNewMessage will.
    const payload = {
      type: "event_callback",
      team_id: TEAM_ID,
      event: {
        type: "message",
        team: TEAM_ID,
        team_id: TEAM_ID,
        user: USER_ID,
        channel: CHANNEL_ID,
        text: "what was MRR last month?",
        ts: "1700000010.000300",
        channel_type: "channel",
      },
    };

    const res = await app.fetch(makeSignedEventRequest(payload));
    expect(res.status).toBe(200);

    // Wait for both meter rows (classify + react). Classify ALWAYS lands
    // first; react only when policy.action === "react".
    await waitFor(() => meterEvents.some((e) => e.eventType === "react"));

    const classify = meterEvents.find((e) => e.eventType === "classify");
    const react = meterEvents.find((e) => e.eventType === "react");
    expect(classify).toBeDefined();
    expect(react).toBeDefined();
    expect(react!.workspaceId).toBe(WORKSPACE_ID);
    expect(react!.channelId).toBe(CHANNEL_ID);

    // executeQuery (host helper for @mentions) MUST NOT fire on the
    // proactive path — it's reserved for the reaction-back / button-
    // click answer flow, which we don't simulate here. If this
    // assertion ever flips green, the proactive path has begun running
    // queries without the asker's explicit consent.
    expect(executeQueryCalls).toHaveLength(0);
  });
});

describe("E2E: chat-interaction webhook — three-layer kill switch (#2607 slice trail)", () => {
  it("workspace toggle off (isEnabled=false) — no meter rows emitted (analytics gap, not silent answer)", async () => {
    currentWorkspaceId = DISABLED_WORKSPACE_ID;

    const payload = {
      type: "event_callback",
      team_id: TEAM_ID,
      event: {
        type: "message",
        team: TEAM_ID,
        team_id: TEAM_ID,
        user: USER_ID,
        channel: CHANNEL_ID,
        text: "what was revenue last week?",
        ts: "1700000020.000400",
        channel_type: "channel",
      },
    };

    const res = await app.fetch(makeSignedEventRequest(payload));
    expect(res.status).toBe(200);

    await waitForQuietPath();
    expect(meterEvents.filter((e) => e.eventType === "react")).toHaveLength(0);
    expect(meterEvents.filter((e) => e.eventType === "classify")).toHaveLength(
      0,
    );
    // Classifier must not have run — the LLM call is the most expensive
    // bit of the path and the workspace-disabled gate exists to skip it.
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it("proactive_pauses row (isPaused=true) — no react meter (handler returns before classify)", async () => {
    currentWorkspaceId = PAUSED_WORKSPACE_ID;

    const payload = {
      type: "event_callback",
      team_id: TEAM_ID,
      event: {
        type: "message",
        team: TEAM_ID,
        team_id: TEAM_ID,
        user: USER_ID,
        channel: CHANNEL_ID,
        text: "how many signups this week?",
        ts: "1700000021.000500",
        channel_type: "channel",
      },
    };

    const res = await app.fetch(makeSignedEventRequest(payload));
    expect(res.status).toBe(200);

    await waitForQuietPath();
    expect(meterEvents.filter((e) => e.eventType === "react")).toHaveLength(0);
    expect(meterEvents.filter((e) => e.eventType === "classify")).toHaveLength(
      0,
    );
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it("DM unsubscribe — short-circuits before classification (meter row absence)", async () => {
    const payload = {
      type: "event_callback",
      team_id: TEAM_ID,
      event: {
        type: "message",
        team: TEAM_ID,
        team_id: TEAM_ID,
        user: USER_ID,
        channel: DM_CHANNEL_ID,
        text: "unsubscribe",
        ts: "1700000022.000600",
        channel_type: "im",
      },
    };

    const res = await app.fetch(makeSignedEventRequest(payload));
    expect(res.status).toBe(200);

    // The AC asks for meter-row absence on the DM unsubscribe path —
    // confirmed by the proactive `react` / `classify` rows never landing.
    // The legacy slack.ts DM path produced no proactive meter rows either,
    // so this is parity.
    await waitForQuietPath();
    expect(meterEvents.filter((e) => e.eventType === "react")).toHaveLength(0);
    expect(meterEvents.filter((e) => e.eventType === "classify")).toHaveLength(
      0,
    );
    expect(mockClassify).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // TODO(#2638): DM `unsubscribe` should also fire `onPauseRequest` with
  // a `user-optout` row so the asker is removed from proactive workspace-
  // wide. The proactive listener has that code path in its
  // `chat.onNewMessage(/.+/)` handler (plugins/chat/src/proactive/
  // listener.ts:454), but the chat SDK routes DMs to mention handlers
  // (not onNewMessage) when no `chat.onDirectMessage` handler is
  // registered — so the unsubscribe branch is unreachable in production.
  // Surfaced by this e2e (#2633); follow-up tracked at #2638.
  // ---------------------------------------------------------------------
  it.todo("DM unsubscribe — fires user-optout onPauseRequest (blocked by #2638: listener missing onDirectMessage registration)", async () => {
    const payload = {
      type: "event_callback",
      team_id: TEAM_ID,
      event: {
        type: "message",
        team: TEAM_ID,
        team_id: TEAM_ID,
        user: USER_ID,
        channel: DM_CHANNEL_ID,
        text: "unsubscribe",
        ts: "1700000023.000700",
        channel_type: "im",
      },
    };
    const res = await app.fetch(makeSignedEventRequest(payload));
    expect(res.status).toBe(200);
    await waitFor(() => pauseRequests.length > 0);
    const req = pauseRequests[0]!;
    expect(req.layer).toBe("user-optout");
    expect(req.workspaceId).toBe(WORKSPACE_ID);
    expect(req.userId).toBe(USER_ID);
    expect(req.channelId).toBeNull();
  });
});
