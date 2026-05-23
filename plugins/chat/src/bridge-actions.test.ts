/**
 * Tests for `dispatchApproveDenyAction` — the approve/deny button
 * handler dispatch path extracted from the `chat.onAction(...)` lambda
 * inside `createChatBridge` (#2693).
 *
 * Asserted invariants (issue #2693 AC, narrowed to the approve/deny
 * subset — Gap 2 OAuth tests are owned by `slack-oauth-handler.test.ts`
 * post-#2689):
 *
 *   - On approve: `actions.get(actionId)` then `actions.approve(actionId, "chat-sdk:<userId>")`,
 *     then `adapter.editMessage` with the formatted result.
 *   - On deny: same shape with `actions.deny`.
 *   - On missing action (`get` returns null): fallback markdown edit.
 *   - On already-resolved (approve|deny returns null): "already resolved" edit.
 *   - On thrown error: error log + fallback edit + survive editMessage failure.
 *   - Empty `event.value`: warn + return (no `actions.get` call).
 *
 * The chat-sdk's `ActionEvent` is structurally compatible with the
 * helper's `ApproveDenyActionEvent` subset, so the test passes plain
 * objects without constructing real chat-sdk types.
 */

import { describe, it, expect, mock } from "bun:test";
import {
  dispatchApproveDenyAction,
  type ApproveDenyActionEvent,
} from "./bridge";
import type { ActionCallbacks } from "./config";
import type { PluginLogger } from "@useatlas/plugin-sdk";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeLogger(): {
  log: PluginLogger;
  infos: Array<unknown[]>;
  warns: Array<unknown[]>;
  errors: Array<unknown[]>;
} {
  const infos: Array<unknown[]> = [];
  const warns: Array<unknown[]> = [];
  const errors: Array<unknown[]> = [];
  return {
    infos,
    warns,
    errors,
    log: {
      info: (...args: unknown[]) => infos.push(args),
      warn: (...args: unknown[]) => warns.push(args),
      error: (...args: unknown[]) => errors.push(args),
      debug: () => {},
    } as unknown as PluginLogger,
  };
}

function makeEvent(
  overrides: Partial<ApproveDenyActionEvent> = {},
): {
  event: ApproveDenyActionEvent;
  editMessage: ReturnType<typeof mock>;
} {
  const editMessage = mock(() => Promise.resolve());
  const event: ApproveDenyActionEvent = {
    actionId: "atlas_action_approve",
    value: "act-123",
    user: { userId: "U-ALICE" },
    threadId: "thread-1",
    messageId: "msg-1",
    adapter: { editMessage },
    ...overrides,
  };
  return { event, editMessage };
}

function makeActions(
  overrides: Partial<ActionCallbacks> = {},
): {
  actions: ActionCallbacks;
  get: ReturnType<typeof mock>;
  approve: ReturnType<typeof mock>;
  deny: ReturnType<typeof mock>;
} {
  const defaultGet = mock(() =>
    Promise.resolve({
      id: "act-123",
      action_type: "send_email",
      target: "users@example.com",
      summary: "Send email to users",
    }),
  );
  const defaultApprove = mock(() =>
    Promise.resolve({ status: "approved", error: null }),
  );
  const defaultDeny = mock(() => Promise.resolve({ denied: true }));
  // Use the override mock when supplied so the returned mock matches
  // the one the helper actually calls — destructuring `get` etc. from a
  // builder pattern is otherwise a footgun (you assert against the
  // default mock instead of the override).
  const get = (overrides.get ?? defaultGet) as ReturnType<typeof mock>;
  const approve = (overrides.approve ?? defaultApprove) as ReturnType<typeof mock>;
  const deny = (overrides.deny ?? defaultDeny) as ReturnType<typeof mock>;
  const actions: ActionCallbacks = { get, approve, deny };
  return { actions, get, approve, deny };
}

// ---------------------------------------------------------------------------
// Happy paths — approve + deny → actor format + editMessage
// ---------------------------------------------------------------------------

describe("dispatchApproveDenyAction — approve happy path", () => {
  it("calls actions.get then actions.approve with chat-sdk:<userId> actor", async () => {
    const { event, editMessage } = makeEvent({
      actionId: "atlas_action_approve",
      value: "act-123",
      user: { userId: "U-ALICE" },
    });
    const { actions, get, approve, deny } = makeActions();
    const { log } = makeLogger();

    await dispatchApproveDenyAction(event, actions, log);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]).toEqual(["act-123"]);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]).toEqual(["act-123", "chat-sdk:U-ALICE"]);
    expect(deny).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledTimes(1);
    const [threadId, messageId, content] = editMessage.mock.calls[0] as [
      string,
      string,
      { markdown: string },
    ];
    expect(threadId).toBe("thread-1");
    expect(messageId).toBe("msg-1");
    expect(content.markdown).toContain("Send email to users");
  });
});

describe("dispatchApproveDenyAction — deny happy path", () => {
  it("calls actions.deny with chat-sdk:<userId> actor and edits the message", async () => {
    const { event, editMessage } = makeEvent({
      actionId: "atlas_action_deny",
      value: "act-deny-1",
      user: { userId: "U-BOB" },
    });
    const { actions, get, approve, deny } = makeActions();
    const { log } = makeLogger();

    await dispatchApproveDenyAction(event, actions, log);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]).toEqual(["act-deny-1"]);
    expect(deny).toHaveBeenCalledTimes(1);
    expect(deny.mock.calls[0]).toEqual(["act-deny-1", "chat-sdk:U-BOB"]);
    expect(approve).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledTimes(1);
    const [, , content] = editMessage.mock.calls[0] as [
      string,
      string,
      { markdown: string },
    ];
    // `formatActionResult(..., "denied")` includes the "denied" status word
    expect(content.markdown.toLowerCase()).toContain("denied");
  });
});

// ---------------------------------------------------------------------------
// Missing-value path — empty `value` is warn + return
// ---------------------------------------------------------------------------

describe("dispatchApproveDenyAction — missing event.value", () => {
  it("warns and returns without calling actions when value is undefined", async () => {
    const { event, editMessage } = makeEvent({ value: undefined });
    const { actions, get, approve, deny } = makeActions();
    const { log, warns } = makeLogger();

    await dispatchApproveDenyAction(event, actions, log);

    expect(get).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    expect(warns.length).toBeGreaterThan(0);
    expect(JSON.stringify(warns[0])).toContain("missing value");
  });
});

// ---------------------------------------------------------------------------
// Missing-action path — actions.get returns null
// ---------------------------------------------------------------------------

describe("dispatchApproveDenyAction — actions.get returns null", () => {
  it("edits the message with the 'no longer available' fallback", async () => {
    const { event, editMessage } = makeEvent();
    const { actions, get, approve } = makeActions({
      get: mock(() => Promise.resolve(null)),
    });
    const { log } = makeLogger();

    await dispatchApproveDenyAction(event, actions, log);

    expect(get).toHaveBeenCalledTimes(1);
    expect(approve).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledTimes(1);
    const [, , content] = editMessage.mock.calls[0] as [
      string,
      string,
      { markdown: string },
    ];
    expect(content.markdown).toContain("no longer available");
  });

  it("survives an editMessage failure during the missing-action fallback (logged as warn)", async () => {
    // The handler tries to edit with the fallback markdown; if the edit
    // itself throws, we should log a warn and return cleanly — not
    // propagate the editMessage error. This is the recovery path the
    // outer try/catch can't reach (already inside the actionEntry===null branch).
    const editMessage = mock(() => Promise.reject(new Error("network blip")));
    const { event } = makeEvent({ adapter: { editMessage } });
    const { actions, approve } = makeActions({
      get: mock(() => Promise.resolve(null)),
    });
    const { log, warns } = makeLogger();

    await expect(
      dispatchApproveDenyAction(event, actions, log),
    ).resolves.toBeUndefined();
    expect(approve).not.toHaveBeenCalled();
    // Two warns: "Action not found" + "Failed to edit message for missing action"
    expect(warns.length).toBe(2);
    expect(JSON.stringify(warns[1])).toContain("Failed to edit message");
  });
});

// ---------------------------------------------------------------------------
// Already-resolved path — approve|deny returns null
// ---------------------------------------------------------------------------

describe("dispatchApproveDenyAction — approve returns null (already resolved)", () => {
  it("edits the message with the 'already been resolved' fallback", async () => {
    const { event, editMessage } = makeEvent({
      actionId: "atlas_action_approve",
    });
    const { actions } = makeActions({
      approve: mock(() => Promise.resolve(null)),
    });
    const { log, warns } = makeLogger();

    await dispatchApproveDenyAction(event, actions, log);

    expect(editMessage).toHaveBeenCalledTimes(1);
    const [, , content] = editMessage.mock.calls[0] as [
      string,
      string,
      { markdown: string },
    ];
    expect(content.markdown).toContain("already been resolved");
    expect(JSON.stringify(warns)).toContain("Action already resolved");
  });
});

describe("dispatchApproveDenyAction — deny returns null (already resolved)", () => {
  it("edits the message with the 'already been resolved' fallback", async () => {
    const { event, editMessage } = makeEvent({
      actionId: "atlas_action_deny",
    });
    const { actions } = makeActions({
      deny: mock(() => Promise.resolve(null)),
    });
    const { log, warns } = makeLogger();

    await dispatchApproveDenyAction(event, actions, log);

    expect(editMessage).toHaveBeenCalledTimes(1);
    const [, , content] = editMessage.mock.calls[0] as [
      string,
      string,
      { markdown: string },
    ];
    expect(content.markdown).toContain("already been resolved");
    expect(JSON.stringify(warns)).toContain(
      "Action already resolved when deny attempted",
    );
  });
});

// ---------------------------------------------------------------------------
// Thrown-error path — actions.get/approve/deny throws
// ---------------------------------------------------------------------------

describe("dispatchApproveDenyAction — actions.approve throws", () => {
  it("logs error and edits the message with the failure fallback", async () => {
    const { event, editMessage } = makeEvent({
      actionId: "atlas_action_approve",
    });
    const { actions } = makeActions({
      approve: mock(() => Promise.reject(new Error("DB exploded"))),
    });
    const { log, errors } = makeLogger();

    await dispatchApproveDenyAction(event, actions, log);

    expect(editMessage).toHaveBeenCalledTimes(1);
    const [, , content] = editMessage.mock.calls[0] as [
      string,
      string,
      { markdown: string },
    ];
    expect(content.markdown).toContain("Failed to process action");
    expect(errors.length).toBe(1);
    expect(JSON.stringify(errors[0])).toContain("Failed to process action");
  });
});

describe("dispatchApproveDenyAction — survives editMessage failure during error recovery", () => {
  it("logs both the dispatch error and the editMessage failure", async () => {
    // actions.approve throws → outer catch tries editMessage with the
    // "Failed to process" markdown → editMessage ALSO throws. The
    // handler should not propagate either; just log and return.
    const editMessage = mock(() => Promise.reject(new Error("network blip")));
    const { event } = makeEvent({
      actionId: "atlas_action_approve",
      adapter: { editMessage },
    });
    const { actions } = makeActions({
      approve: mock(() => Promise.reject(new Error("DB exploded"))),
    });
    const { log, errors, warns } = makeLogger();

    await expect(
      dispatchApproveDenyAction(event, actions, log),
    ).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
    expect(JSON.stringify(errors[0])).toContain("Failed to process action");
    expect(warns.length).toBe(1);
    expect(JSON.stringify(warns[0])).toContain(
      "Failed to edit message with action error",
    );
  });
});
