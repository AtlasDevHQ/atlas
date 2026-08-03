/**
 * Mention-detection regression tests for the Slack adapter wrapper (#4909).
 *
 * The bug: in multi-workspace deploys an @-mention that arrives as a plain
 * `message` event (which happens whenever `message.channels` /
 * `message.groups` are subscribed alongside `app_mention` — Slack sends
 * BOTH, and the SDK dedupes them by shared `ts`, so only the first-processed
 * one survives) was never recognised as a mention, and fell through to the
 * pattern handlers instead of the mention handler.
 *
 * These drive the REAL `Chat` dispatch rather than reimplementing
 * `detectMention`, so they fail if the SDK changes how `isMention` is
 * resolved — which is the thing worth knowing about.
 */

import { describe, expect, it } from "bun:test";
import { createSlackAdapter } from "./slack";
import { DEFAULT_BOT_USER_NAME } from "../config";

const BASE = {
  signingSecret: "x".repeat(32),
  clientId: "cid",
  clientSecret: "csec",
  encryptionKey: Buffer.alloc(32).toString("base64"),
};

describe("createSlackAdapter — mention detection wiring", () => {
  it("sets userName so it does not fall back to the adapter's 'bot' default", () => {
    const a = createSlackAdapter(BASE) as unknown as { userName: string };
    // "bot" is `@chat-adapter/slack`'s ctor default, replaced only inside
    // initialize() from auth.test — which multi-workspace never runs. It is
    // truthy, so it SHADOWS chat.userName in `adapter.userName ||
    // chat.userName` and makes name matching impossible.
    expect(a.userName).not.toBe("bot");
    expect(a.userName).toBe(DEFAULT_BOT_USER_NAME);
  });

  it("honours an explicit userName override for a renamed bot", () => {
    const a = createSlackAdapter({ ...BASE, userName: "datapal" }) as unknown as {
      userName: string;
    };
    expect(a.userName).toBe("datapal");
  });
});

describe("Chat dispatch — @-mention arriving as a plain message event", () => {
  /**
   * Build a real `Chat` around the real Slack adapter and record which
   * handler chain a message lands in.
   */
  async function dispatch(text: string) {
    const { Chat } = await import("chat");
    const { createStateAdapter } = await import("../state");
    const state = createStateAdapter({ backend: "memory" }, null);
    await state.connect();

    const adapter = createSlackAdapter(BASE);
    const chat = new Chat({
      userName: DEFAULT_BOT_USER_NAME,
      adapters: { slack: adapter },
      state,
    });

    const hits: string[] = [];
    chat.onNewMention(async () => { hits.push("mention"); });
    chat.onNewMessage(/.+/, async () => { hits.push("pattern"); });

    // A plain `message` event — `isMention` unset, exactly what Slack
    // delivers for message.channels. The bot's own <@id> has already been
    // rewritten to its display name by resolveInlineMentions, so no user
    // id survives in the text; name matching is the only route left.
    const msg = (adapter as unknown as {
      parseSlackMessageSync: (e: unknown, t: string) => unknown;
    }).parseSlackMessageSync(
      { ts: "1700000000.0001", text, user: "U0HUMAN", channel: "C1" },
      "slack:C1:1700000000.0001",
    );

    chat.processMessage(
      adapter as never,
      "slack:C1:1700000000.0001",
      msg as never,
    );
    // processMessage is fire-and-forget; let its async chain settle.
    await new Promise((r) => setTimeout(r, 150));
    await chat.shutdown?.();
    return hits;
  }

  it("routes a display-name mention to the mention handler, not the pattern chain", async () => {
    // What production actually sees post-resolveInlineMentions.
    expect(await dispatch("@Atlas what is MRR?")).toContain("mention");
  });

  it("still routes an unrelated message to the pattern chain", async () => {
    // The negative: proactive must keep seeing ordinary channel chatter,
    // or this "fix" would silently swallow the proactive pillar's input.
    const hits = await dispatch("deploy went out this morning");
    expect(hits).toContain("pattern");
    expect(hits).not.toContain("mention");
  });
});

/**
 * Pinning tests for `patches/@chat-adapter%2Fslack@4.23.0.patch` (#4911).
 *
 * Upstream's `resolveInlineMentions` suppresses the bot's own `<@U…>` via the
 * INSTANCE field `_botUserId`. That field has two writers: the constructor's
 * `config.botUserId`, and `auth.test` inside `initialize()` — which only runs on
 * the single-workspace `defaultBotToken` path. Neither reaches multi-workspace:
 * `plugins/chat/src/adapters/slack.ts` cannot forward `config.botUserId`, because
 * one static id cannot serve N workspace installs (`packages/api/src/lib/slack/
 * store.ts` carries the same reasoning). So the field is null,
 * the guard never fires, the bot's id is rewritten to its Slack display name, and
 * `detectMention`'s two id patterns have nothing left to match.
 *
 * The patch swaps the field for the `botUserId` GETTER, which prefers the
 * per-request `ctx.botUserId` that `resolveTokenForTeam` supplies. Two things say
 * this is an upstream oversight rather than a design choice: the same class's
 * `isMessageFromSelf` does exactly that ctx-aware fallback, and upstream's own
 * JSDoc on the parameter (`dist/index.d.ts`) states the invariant the patch
 * restores — `skipSelfMention` exists "so that mention detection (which looks for
 * @botUserId in the text) continues to work".
 *
 * WHY A TEST AND NOT JUST THE PATCH. Carrying a vendored patch is only safe if a
 * bump that drops or invalidates it fails CI instead of failing prod silently,
 * and `bun install` only partly provides that. Measured on bun 1.3.13 (the repo
 * pins `"bun": ">=1.3.13 <1.3.14"` and CI sets `BUN_VERSION: "1.3.13"`, so this
 * is authoritative everywhere today and must be re-measured on a bun bump):
 *   - patch file MISSING          → hard error, `bun install` exits 1. Loud.
 *   - `patchedDependencies` key naming a version no longer installed
 *                                 → SILENTLY ignored; install succeeds unpatched.
 *   - hunk context no longer matches
 *                                 → applied FUZZILY with no warning.
 * The last two are the realistic bump outcomes, so THIS BLOCK is the gate for
 * them. A dropped patch is a total-silence failure in Slack, which is why #4909
 * needed a prod incident and a log dive to find. Mitigating context:
 * `plugins/chat/package.json` pins `@chat-adapter/slack` EXACT (no caret), so
 * only a deliberate bump can invalidate the patch — never passive drift.
 *
 * TRIAGING A RED HERE. Three causes, three opposite responses:
 *   1. The patch stopped taking effect → fix the patch.
 *   2. One of the members this block reaches for was renamed → fix the test.
 *      `requestContext`, `lookupUser`, `parseSlackMessage` and `_botUserId` are
 *      `private` in the published `.d.ts`, so their renames are semver-invisible;
 *      `setInstallation` is public, so its rename would show in a changelog.
 *   3. Webhook test only, and it presents identically to (1): if
 *      `resolveTokenForTeam` can't read the installation row, the adapter logs
 *      `Could not resolve token for team` and returns 200 having processed
 *      nothing, so the visible failure is the mention assertion while the real
 *      fault is `setInstallation` / token encryption. Check stdout for that warn.
 * Decide which before touching anything — do NOT resolve a red by deleting the
 * patch entry or loosening an assertion.
 *
 * WHAT REVERTING THE PATCH ACTUALLY REDDENS: exactly two of the six cases here,
 * "never looks up the bot's own id" and the webhook case. The other four are
 * patch-insensitive by construction and each says so at its own site. Expect two
 * reds, not six.
 *
 * The webhook case — the only one that reaches `detectMention` — deliberately
 * gives the bot a Slack display name that DIFFERS from `userName`: with the name
 * backstop matching, an id-only mention would be detected either way and it would
 * pin nothing. That invariant is asserted, not just asserted-in-prose — see the
 * first `it` below.
 */
describe("multi-workspace self-mention suppression (vendored patch #4911)", () => {
  const BOT_ID = "U0BOTXYZ";
  const HUMAN_ID = "U0HUMAN";
  const TEAM_ID = "T1";
  /** Deliberately != DEFAULT_BOT_USER_NAME so name matching cannot rescue a red. */
  const BOT_DISPLAY_NAME = "data-copilot";

  type AdapterInternals = {
    _botUserId: string | null;
    requestContext: { run: <T>(store: unknown, fn: () => T) => T };
    lookupUser: (id: string) => Promise<{ displayName: string; realName: string }>;
    parseSlackMessage: (event: unknown, threadId: string) => Promise<{ text: string }>;
    setInstallation: (
      teamId: string,
      installation: { botToken: string; botUserId?: string },
    ) => Promise<void>;
  };

  /**
   * Build a multi-workspace adapter — OAuth creds and no `botToken`, so
   * `defaultBotToken` is unset. `BASE` also passes no `botUserId`, so
   * `_botUserId` is null straight from the constructor, and `initialize()`
   * cannot fill it either: the `auth.test` writer is guarded on
   * `defaultBotToken`, so it stays skipped even in the webhook case, which does
   * call `chat.initialize()`.
   *
   * `lookupUser` is stubbed so no Slack API call is made, and every id it is
   * asked about is RECORDED. Recording is not incidental: the real `lookupUser`
   * swallows its own errors and returns `{ displayName: userId }`, so if this
   * stub ever stopped intercepting (upstream rename, cache wrapper, inlining)
   * an unpatched adapter would produce the SAME rendered text this block
   * expects — a false green, plus live egress to slack.com from CI. Asserting
   * on which ids were looked up is unforgeable by a decayed stub.
   */
  function multiWorkspaceAdapter() {
    const adapter = createSlackAdapter(BASE);
    const looked: string[] = [];
    (adapter as unknown as AdapterInternals).lookupUser = async (id: string) => {
      looked.push(id);
      return {
        displayName: id === BOT_ID ? BOT_DISPLAY_NAME : `human-${id}`,
        realName: id,
      };
    };
    return { adapter, internals: adapter as unknown as AdapterInternals, looked };
  }

  const event = (text: string) => ({
    ts: "1700000000.0002",
    text,
    user: HUMAN_ID,
    channel: "C1",
  });

  const ctx = (botUserId?: string) => ({
    ...(botUserId ? { botUserId } : {}),
    teamId: TEAM_ID,
    token: "xoxb-test",
  });

  it("keeps the bot's display name distinct from the handle it answers to", () => {
    // Load-bearing for the webhook case below — the only one that reaches
    // `detectMention`. If these collide, its NAME pattern matches and the test
    // stops discriminating between a patched and an unpatched adapter without
    // going red. (The `parseSlackMessage` cases assert exact text, so they keep
    // discriminating regardless.) A static invariant over two constants —
    // patch-insensitive, green either way.
    expect(BOT_DISPLAY_NAME).not.toBe(DEFAULT_BOT_USER_NAME);
  });

  it("never looks up the bot's own id, so its <@id> survives for id matching", async () => {
    const { internals, looked } = multiWorkspaceAdapter();

    // Production wraps event handling in `requestContext.run(ctx, …)` after
    // `resolveTokenForTeam`, so `ctx.botUserId` is the only correct id here.
    const msg = await internals.requestContext.run(ctx(BOT_ID), () =>
      internals.parseSlackMessage(event(`<@${BOT_ID}> what is MRR?`), "slack:C1:x"),
    );

    // `parseSlackMessage` looks up the message author whenever the event carries
    // no `username` — which `event()` never sets — so this is the stub-liveness
    // proof: a decayed stub records nothing and fails HERE, before the real
    // `lookupUser`'s error-fallback could forge the assertions below.
    expect(looked).toContain(HUMAN_ID);
    // The patch's actual effect: the bot is deleted from the lookup set.
    expect(looked).not.toContain(BOT_ID);
    // …and the rendered result. Unpatched this is "@data-copilot what is MRR?".
    expect(msg.text).toBe(`@${BOT_ID} what is MRR?`);
  });

  it("still resolves OTHER users' mentions to display names", async () => {
    // Rules out the lazy "fix" of disabling resolution wholesale — everyone
    // except the bot must still render as a name. Patch-insensitive: unpatched,
    // `_botUserId` is null so the guard is skipped entirely and U0ALICE is
    // looked up either way. It is a control, not a pin.
    const { internals, looked } = multiWorkspaceAdapter();

    const msg = await internals.requestContext.run(ctx(BOT_ID), () =>
      internals.parseSlackMessage(event("<@U0ALICE> owns this"), "slack:C1:x"),
    );

    expect(looked).toContain("U0ALICE");
    expect(msg.text).toBe("@human-U0ALICE owns this");
  });

  it("keeps the single-workspace path working: no ctx, instance field set", async () => {
    // The getter's fallback is `this._botUserId || void 0`, so a self-hosted
    // single-workspace deploy (where `initialize()`'s `auth.test` populated the
    // instance field and no request context exists) must behave exactly as it
    // did before the patch. If upstream ever drops that fallback, the patch
    // would trade a multi-workspace bug for a single-workspace one — silently.
    // Insensitive to the patch itself (it sets exactly the field the UNPATCHED
    // guard reads, so the delete happens in both worlds); it pins the getter.
    const { internals, looked } = multiWorkspaceAdapter();
    internals._botUserId = BOT_ID;

    const msg = await internals.parseSlackMessage(
      event(`<@${BOT_ID}> what is MRR?`),
      "slack:C1:x",
    );

    expect(looked).not.toContain(BOT_ID);
    expect(msg.text).toBe(`@${BOT_ID} what is MRR?`);
  });

  it("documents the install class the patch does NOT reach: no ctx botUserId", async () => {
    // `ctx.botUserId` comes from the `chat_cache` installation row, and that row
    // can lack it — `lib/slack/store.ts:upsert()` spreads it conditionally, and
    // `slack-oauth-handler.ts` warns rather than refusing when Slack's OAuth
    // response omits `bot_user_id`. With neither ctx nor the instance field set,
    // the getter yields undefined, the guard cannot fire, and name matching is
    // still the only route for that workspace.
    //
    // NOTE — this is an ANTI-pin: it asserts the UNPATCHED output, so it stays
    // green if the patch is reverted (as do the two controls above, each for its
    // own reason). It keeps the contract doc's hedge honest, not the patch.
    // If that install class is ever eliminated (Atlas backfilling `bot_user_id`,
    // or the adapter refusing installs without it) this test goes red and must
    // be DELETED, not repaired.
    const { internals } = multiWorkspaceAdapter();

    const msg = await internals.requestContext.run(ctx(), () =>
      internals.parseSlackMessage(event(`<@${BOT_ID}> what is MRR?`), "slack:C1:x"),
    );

    expect(msg.text).toBe(`@${BOT_DISPLAY_NAME} what is MRR?`);
  });

  it("detects an id-only mention through the real webhook path", async () => {
    // The end-to-end shape. Everything above hand-injects the ALS store, so none
    // of it would notice if upstream stopped WRAPPING the event in a request
    // context (it already has `withToken`/`withBotToken` for per-call token
    // resolution — a plausible refactor). That would make the patch a prod
    // no-op with every other test still green. This one drives a signed
    // `event_callback` through `chat.webhooks.slack`, so the context comes from
    // the adapter's own `resolveTokenForTeam` reading a real installation row.
    const { createHmac } = await import("node:crypto");
    const { Chat } = await import("chat");
    const { createStateAdapter } = await import("../state");
    const state = createStateAdapter({ backend: "memory" }, null);
    await state.connect();

    const { adapter, internals, looked } = multiWorkspaceAdapter();
    const chat = new Chat({
      userName: DEFAULT_BOT_USER_NAME,
      adapters: { slack: adapter },
      state,
    });
    // `setInstallation` needs the adapter bound to a Chat instance.
    await chat.initialize();
    await internals.setInstallation(TEAM_ID, {
      botToken: "xoxb-test",
      botUserId: BOT_ID,
    });

    const hits: string[] = [];
    chat.onNewMention(async () => {
      hits.push("mention");
    });
    chat.onNewMessage(/.+/, async () => {
      hits.push("pattern");
    });

    // A plain `message` event (NOT app_mention), so `isMention` is unset and
    // `detectMention` has to do the work — the #4909 shape.
    const body = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_ID,
      event: { ...event(`<@${BOT_ID}> what is MRR?`), type: "message" },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = `v0=${createHmac("sha256", BASE.signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;

    // Production returns 200 immediately and relies on AsyncLocalStorage
    // propagating into the detached chain; `waitUntil` is the same hook the real
    // route uses (plugins/chat/src/index.ts) and lets the assertion observe the
    // result without a sleep.
    // Collect every registered task rather than the last one — the message path
    // registers exactly one today, but a second would otherwise go unawaited.
    const tasks: Promise<unknown>[] = [];
    const res = await chat.webhooks.slack(
      new Request("https://example.test/webhooks/slack", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
        body,
      }),
      { waitUntil: (t: Promise<unknown>) => { tasks.push(t); } },
    );
    // Ordered before the await so a 401 fails here rather than as an empty
    // `hits`. A resolve failure still returns 200, which the assertions catch.
    expect(res.status).toBe(200);
    await Promise.all(tasks);
    await chat.shutdown?.();

    // Stub liveness first (see "never looks up the bot's own id" for why), then
    // the patch's effect, then the behaviour the whole patch exists for.
    expect(looked).toContain(HUMAN_ID);
    expect(looked).not.toContain(BOT_ID);
    expect(hits).toContain("mention");
    expect(hits).not.toContain("pattern");
  });
});

