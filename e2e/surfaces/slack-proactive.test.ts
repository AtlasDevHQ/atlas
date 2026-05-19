/**
 * E2E: Plugin-webhook (chat-interaction) surface.
 *
 * #2633 — closes the integration-test gap left by slice 3 of the
 * proactive-listener wiring trail (parent #2607). Slice 3 (PR #2626)
 * migrated Slack `app_mention` + thread-followup from
 * `packages/api/src/api/routes/slack.ts` to the `@useatlas/chat` plugin
 * webhook (`/api/plugins/chat-interaction/webhooks/slack`). Slack API
 * calls are stubbed at the `@slack/web-api` module boundary (see
 * `StubWebClient` below) — the legacy `slack.test.ts` pattern of
 * patching `globalThis.fetch` doesn't intercept the axios-backed SDK
 * that `@chat-adapter/slack` constructs. The host helper unit tests in
 * `packages/api/src/lib/chat-plugin/__tests__/execute-query.test.ts`
 * pin envelope shape in isolation; this surface drives the full chain
 * end to end:
 *
 *   Slack-signed request
 *     → chat-interaction webhook route
 *     → Slack adapter signature verify + event parse
 *     → bridge `onNewMention` / proactive `onNewMessage` handler
 *     → host `executeQuery` / proactive meter callback
 *     → Slack API stub (chat.postMessage / reactions.add)
 *
 * Behaviors covered:
 *
 *   1. `app_mention` envelope parity — answer text + `thread_ts` + the
 *      `:lock:` notice when the agent reports `pendingApproval` —
 *      matches the pre-#2626 envelope `slack.ts` produced.
 *
 *   2. Proactive happy path — a `message` event in a channel
 *      allowlisted via `channel_proactive_config` emits a `react` meter
 *      row, and crucially does *not* call `executeQuery` or
 *      `chat.postMessage` (the consent gate the asker hasn't crossed
 *      yet). This is the surface PR #2628 ("channelAllowed read from
 *      the legacy env-var allowlist") would have failed.
 *
 *   3. Kill switch — workspace toggle off / `proactive_pauses` row each
 *      short-circuit before classification. Tests pair a positive
 *      "handler ran" assertion (`mockResolveWorkspaceId` was called)
 *      with the meter-row-absence check — without the positive half,
 *      the assertion is trivially satisfied if the handler never
 *      registered or threw inside its outer `try` block (see #2638 for
 *      the DM-routing variant where this would otherwise mask a bug).
 *
 *   4. DM `unsubscribe` is *unreachable* via `onNewMessage` (chat SDK
 *      routes DMs to mention handlers). Documented as such — the test
 *      asserts `mockResolveWorkspaceId` was *not* called for the DM
 *      event, pinning the production gap until #2638 lands an
 *      `onDirectMessage` registration.
 *
 * Plugin webhook only — the legacy `/api/v1/slack/*` slash +
 * interaction paths stay covered by `slack.test.ts`.
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
  chat = {
    postMessage: async (args: { channel: string; thread_ts?: string }) => {
      stubWebClientPostCalls.push({ method: "chat.postMessage", args });
      return { ok: true, ts: "9999999999.000099", channel: args.channel };
    },
    update: async () => ({ ok: true }),
    postEphemeral: async () => ({ ok: true }),
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
// resolver path. A small in-test router avoids a workspace dependency
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
  adapterName: string;
  rawMessage: Record<string, unknown> | undefined;
  threadId: string;
}
const executeQueryCalls: ExecuteQueryCall[] = [];

type ExecuteQueryReturn = {
  answer: string;
  sql: string[];
  data: { columns: string[]; rows: Record<string, unknown>[] }[];
  steps: number;
  usage: { totalTokens: number };
};

const DEFAULT_EXECUTE_QUERY_RETURN: ExecuteQueryReturn = {
  answer: "There are 42 active users.",
  sql: ["SELECT COUNT(*) FROM users"],
  data: [{ columns: ["count"], rows: [{ count: 42 }] }],
  steps: 1,
  usage: { totalTokens: 100 },
};

let executeQueryReturn: ExecuteQueryReturn = DEFAULT_EXECUTE_QUERY_RETURN;

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
      rawMessage: ctx.rawMessage as Record<string, unknown> | undefined,
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
  // Clear every mock — the `mockResolveWorkspaceId` / `mockIsEnabled`
  // counters are load-bearing for the kill-switch assertions below, and
  // a left-over call from a previous test would silently pass them.
  // The boot-time `isEnabled("")` registration probe lands in `beforeAll`
  // before this clear runs, so its counter starts fresh per test.
  mockExecuteQuery.mockClear();
  mockMeterEvent.mockClear();
  mockPauseRequest.mockClear();
  mockClassify.mockClear();
  mockResolveWorkspaceId.mockClear();
  mockIsEnabled.mockClear();
  mockIsPaused.mockClear();
  mockGetWorkspaceConfig.mockClear();
  mockGetChannelConfigs.mockClear();
  // Reset the per-test workspace id so a kill-switch test from earlier
  // doesn't leak into the next.
  currentWorkspaceId = WORKSPACE_ID;
  executeQueryReturn = DEFAULT_EXECUTE_QUERY_RETURN;
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
 * Wait until the proactive handler has demonstrably fired —
 * `mockResolveWorkspaceId` is the first await in `onNewMessage`
 * (`plugins/chat/src/proactive/listener.ts`, `safeResolveWorkspace`
 * call), so a non-zero call count proves the handler started.
 * Bounded-positive: a fixed sleep would let a slow CI worker mask the
 * handler-never-fires failure mode the kill-switch tests exist to
 * catch. After the call lands, yield one microtask tick for any
 * post-gate work to settle before assertions run.
 */
async function waitForProactiveHandlerRan(): Promise<void> {
  await waitFor(() => mockResolveWorkspaceId.mock.calls.length > 0);
  await new Promise((r) => setTimeout(r, 10));
}

/**
 * Build a Slack `event_callback` envelope. All tests in this surface
 * use the same outer shell + `team_id`; only the inner `event` differs
 * per-case.
 */
function makeEventPayload(event: {
  type: "app_mention" | "message";
  text: string;
  ts: string;
  channel: string;
  channelType?: "channel" | "im";
}): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: TEAM_ID,
    event: {
      type: event.type,
      team: TEAM_ID,
      team_id: TEAM_ID,
      user: USER_ID,
      channel: event.channel,
      text: event.text,
      ts: event.ts,
      ...(event.channelType ? { channel_type: event.channelType } : {}),
    },
  };
}

/**
 * Assert that the proactive listener short-circuited before doing any
 * billable work — no `react` or `classify` meter rows, classifier never
 * invoked. Pair with `waitForProactiveHandlerRan()` so the absence
 * reflects a gate firing, not a handler-never-ran silent skip.
 */
function expectNoProactiveActivity(): void {
  expect(meterEvents.filter((e) => e.eventType === "react")).toHaveLength(0);
  expect(meterEvents.filter((e) => e.eventType === "classify")).toHaveLength(0);
  expect(mockClassify).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: chat-interaction webhook — app_mention envelope parity (#2626 / #2607)", () => {
  it("posts a signed app_mention → executeQuery runs with adapter='slack' + raw event + reply text/thread_ts match pre-#2626 envelope", async () => {
    const eventTs = "1700000001.000100";
    const payload = makeEventPayload({
      type: "app_mention",
      text: "<@U_BOT> how many active users?",
      ts: eventTs,
      channel: CHANNEL_ID,
    });

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

    const payload = makeEventPayload({
      type: "app_mention",
      text: "<@U_BOT> show me PII",
      ts: "1700000002.000200",
      channel: CHANNEL_ID,
    });

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
    const payload = makeEventPayload({
      type: "message",
      text: "what was MRR last month?",
      ts: "1700000010.000300",
      channel: CHANNEL_ID,
      channelType: "channel",
    });

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

    // The proactive path posts no channel message — only the 🤖
    // reaction and an ephemeral offer card. If `chat.postMessage` ever
    // lands here, the listener has started answering questions the
    // asker hasn't consented to (the exact failure profile #2628
    // touched: silent agent activity in a wrong-gate scenario).
    expect(
      stubWebClientPostCalls.filter((c) => c.method === "chat.postMessage"),
    ).toHaveLength(0);
    // executeQuery (host helper for @mentions) MUST NOT fire on the
    // proactive path — it's reserved for the reaction-back / button-
    // click answer flow, which we don't simulate here. If this
    // assertion ever flips green, the proactive path has begun running
    // queries without the asker's explicit consent.
    expect(executeQueryCalls).toHaveLength(0);
  });
});

describe("E2E: chat-interaction webhook — kill switch (#2607 slice trail)", () => {
  it("workspace toggle off (isEnabled=false) — handler runs, gate fires, no meter rows", async () => {
    currentWorkspaceId = DISABLED_WORKSPACE_ID;

    const payload = makeEventPayload({
      type: "message",
      text: "what was revenue last week?",
      ts: "1700000020.000400",
      channel: CHANNEL_ID,
      channelType: "channel",
    });

    const res = await app.fetch(makeSignedEventRequest(payload));
    expect(res.status).toBe(200);

    // Positive proof the handler actually ran: `resolveWorkspaceId` is
    // the first await in `onNewMessage`. Without this, the meter-row
    // absence below would also pass if the listener never registered
    // or threw inside its outer `try` block (`listener.ts` swallows
    // handler crashes at `log.warn`-level by design — the failure mode
    // this PR exists to catch).
    await waitForProactiveHandlerRan();
    expect(mockIsEnabled).toHaveBeenCalledWith(DISABLED_WORKSPACE_ID);
    expectNoProactiveActivity();
    // The workspace-disabled gate skips ALL DB reads after the
    // `isEnabled` check — no quota lookup, no channel-config fetch,
    // no pause registry hit. Pin the per-event ordering.
    expect(mockIsPaused).not.toHaveBeenCalled();
    expect(mockGetWorkspaceConfig).not.toHaveBeenCalled();
  });

  it("proactive_pauses row (isPaused=true) — handler runs, pause registry consulted, no react meter", async () => {
    currentWorkspaceId = PAUSED_WORKSPACE_ID;

    const payload = makeEventPayload({
      type: "message",
      text: "how many signups this week?",
      ts: "1700000021.000500",
      channel: CHANNEL_ID,
      channelType: "channel",
    });

    const res = await app.fetch(makeSignedEventRequest(payload));
    expect(res.status).toBe(200);

    await waitForProactiveHandlerRan();
    expect(mockIsEnabled).toHaveBeenCalledWith(PAUSED_WORKSPACE_ID);
    // The pause registry is the ONLY thing that should fire between
    // `isEnabled` and the early return. If a regression bypassed
    // `isPaused`, classify would land below — but if `isPaused` itself
    // is unwired, the test would still pass on meter absence alone.
    expect(mockIsPaused).toHaveBeenCalled();
    expectNoProactiveActivity();
  });

  // ---------------------------------------------------------------------
  // DM `unsubscribe` is a documented production gap (#2638), not a
  // working kill-switch layer. The proactive listener's
  // `chat.onNewMessage(/.+/)` handler (see the `detectUnsubscribeDM`
  // branch in `plugins/chat/src/proactive/listener.ts`) checks for DM
  // unsubscribe — but the chat SDK routes DMs to mention handlers, not
  // `onNewMessage`, when no `chat.onDirectMessage` handler is
  // registered. So the listener's onNewMessage handler *never fires*
  // for DMs in production.
  //
  // This test pins that gap explicitly: `mockResolveWorkspaceId` must
  // NOT have been called for the DM event (proof the listener didn't
  // run). A naive "no meter rows landed" assertion would silently pass
  // whether the listener fired-and-gated or never fired at all — the
  // earlier draft of this test had exactly that hole (#2633 review).
  // ---------------------------------------------------------------------
  it("DM unsubscribe — proactive listener does NOT fire for DMs (documents production gap #2638)", async () => {
    const payload = makeEventPayload({
      type: "message",
      text: "unsubscribe",
      ts: "1700000022.000600",
      channel: DM_CHANNEL_ID,
      channelType: "im",
    });

    const res = await app.fetch(makeSignedEventRequest(payload));
    expect(res.status).toBe(200);

    // Long enough that, if the listener WERE wired for DMs, its first
    // await (`resolveWorkspaceId`) would have landed. The negative
    // assertion below catches the day #2638 ships an `onDirectMessage`
    // registration without updating this test — it will start failing
    // (the gap is closed) and the `.todo` below can be promoted to a
    // real assertion in the same PR.
    await new Promise((r) => setTimeout(r, 200));
    expect(mockResolveWorkspaceId).not.toHaveBeenCalled();
    expectNoProactiveActivity();
    expect(mockPauseRequest).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // TODO(#2638): DM `unsubscribe` should also fire `onPauseRequest`
  // with a `user-optout` row so the asker is removed from proactive
  // workspace-wide. When the listener adds a
  // `chat.onDirectMessage(...)` registration that re-dispatches to its
  // unsubscribe branch, drop the `.todo`, update the test above to
  // assert `mockResolveWorkspaceId` *was* called, and remove this
  // block (its assertion will move into a real test).
  // ---------------------------------------------------------------------
  it.todo("DM unsubscribe — fires user-optout onPauseRequest (blocked by #2638: listener missing onDirectMessage registration)", async () => {
    const payload = makeEventPayload({
      type: "message",
      text: "unsubscribe",
      ts: "1700000023.000700",
      channel: DM_CHANNEL_ID,
      channelType: "im",
    });
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
