import { describe, it, expect } from "bun:test";
import {
  resolveConversationUrlAction,
  type ConversationUrlInput,
} from "../components/search-params";

/**
 * `resolveConversationUrlAction` is the pure decision behind AtlasChat's
 * URL-driven conversation-open effect (#3068). It maps the current `?id=`
 * value (plus auth/groups readiness) to open / clear / noop.
 *
 * The branch that matters most: a signed-in managed user must WAIT for the
 * connection-groups fetch to settle (so #3065 scope restore validates against
 * real groups), but a self-hosted / simple-key deploy NEVER fetches groups —
 * gating on `envGroupsHasLoaded` there would leave a deep-linked conversation
 * permanently unopened.
 */
function input(overrides: Partial<ConversationUrlInput> = {}): ConversationUrlInput {
  return {
    urlId: "",
    loadedId: null,
    authResolved: true,
    isSignedIn: true,
    envGroupsHasLoaded: true,
    ...overrides,
  };
}

describe("resolveConversationUrlAction", () => {
  it("waits until auth has resolved", () => {
    expect(
      resolveConversationUrlAction(input({ urlId: "conv-1", authResolved: false })),
    ).toEqual({ kind: "noop" });
  });

  it("does nothing for an empty URL on a fresh chat", () => {
    expect(resolveConversationUrlAction(input({ urlId: "", loadedId: null }))).toEqual({
      kind: "noop",
    });
  });

  it("clears when the URL empties but a conversation is loaded (back-nav to empty)", () => {
    expect(
      resolveConversationUrlAction(input({ urlId: "", loadedId: "conv-1" })),
    ).toEqual({ kind: "clear" });
  });

  it("does nothing when the URL already names the loaded conversation", () => {
    expect(
      resolveConversationUrlAction(input({ urlId: "conv-1", loadedId: "conv-1" })),
    ).toEqual({ kind: "noop" });
  });

  it("opens a deep-linked conversation once groups have settled (signed in)", () => {
    expect(
      resolveConversationUrlAction(
        input({
          urlId: "conv-1",
          loadedId: null,
          isSignedIn: true,
          envGroupsHasLoaded: true,
        }),
      ),
    ).toEqual({ kind: "open", id: "conv-1" });
  });

  it("waits for the groups fetch to settle before opening (signed in)", () => {
    expect(
      resolveConversationUrlAction(
        input({
          urlId: "conv-1",
          loadedId: null,
          isSignedIn: true,
          envGroupsHasLoaded: false,
        }),
      ),
    ).toEqual({ kind: "noop" });
  });

  it("opens immediately on self-hosted / simple-key (no groups fetch to wait on)", () => {
    // The connection-groups query is disabled when not signed in, so its
    // `hasLoaded` never flips. Gating on it would strand the deep link forever.
    expect(
      resolveConversationUrlAction(
        input({
          urlId: "conv-1",
          loadedId: null,
          isSignedIn: false,
          envGroupsHasLoaded: false,
        }),
      ),
    ).toEqual({ kind: "open", id: "conv-1" });
  });

  it("opens a different conversation on back/forward navigation", () => {
    expect(
      resolveConversationUrlAction(
        input({ urlId: "conv-2", loadedId: "conv-1", envGroupsHasLoaded: true }),
      ),
    ).toEqual({ kind: "open", id: "conv-2" });
  });

  it("still waits for groups when switching conversations while signed in", () => {
    expect(
      resolveConversationUrlAction(
        input({
          urlId: "conv-2",
          loadedId: "conv-1",
          isSignedIn: true,
          envGroupsHasLoaded: false,
        }),
      ),
    ).toEqual({ kind: "noop" });
  });
});
