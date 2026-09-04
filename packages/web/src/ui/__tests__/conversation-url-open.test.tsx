/**
 * `ui/components/search-params` — the chat surface's URL contract.
 *
 * Merged 2026-09-04; formerly also conversation-url.test.ts (the pure
 * resolver) and prompt-prefill.test.tsx (#3081).
 */

import { describe, it, expect, mock, afterEach } from "bun:test";
import { render, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryStates } from "nuqs";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";
import {
  chatSearchParams,
  resolveConversationUrlAction,
  type ConversationUrlInput,
} from "../components/search-params";

/**
 * Integration coverage for #3068: the conversation lives in the URL (`?id=`).
 * These drive the REAL `chatSearchParams` parser + `resolveConversationUrlAction`
 * through a real nuqs adapter, so a deep link / reload opens the conversation and
 * a navigation writes the URL — the wiring `AtlasChat`'s URL-driven effect relies
 * on, without mounting the whole chat. The harness effect mirrors that effect
 * verbatim (open on a settled id, clear on an emptied one).
 */
function Harness(props: {
  authSettled: boolean;
  isSignedIn: boolean;
  envGroupsHasLoaded: boolean;
  onOpen: (id: string) => void;
  onClear: () => void;
}) {
  const [params, setParams] = useQueryStates(chatSearchParams);
  const openedRef = useRef<string | null>(null);
  const onOpenRef = useRef(props.onOpen);
  onOpenRef.current = props.onOpen;
  const onClearRef = useRef(props.onClear);
  onClearRef.current = props.onClear;
  useEffect(() => {
    const action = resolveConversationUrlAction({
      urlId: params.id,
      loadedId: openedRef.current,
      authSettled: props.authSettled,
      isSignedIn: props.isSignedIn,
      envGroupsHasLoaded: props.envGroupsHasLoaded,
    });
    if (action.kind === "open") {
      openedRef.current = action.id;
      onOpenRef.current(action.id);
    } else if (action.kind === "clear") {
      openedRef.current = null;
      onClearRef.current();
    }
  }, [params.id, props.authSettled, props.isSignedIn, props.envGroupsHasLoaded]);
  return createElement(
    "button",
    { onClick: () => void setParams({ id: "conv-2" }, { history: "push" }) },
    "go",
  );
}

/**
 * A fuller harness modelling handleSelectConversation's async load lifecycle —
 * the in-flight guard, the up-front "latest requested" record + URL write, and
 * the post-await stale bail — plus the URL-driven effect with `loading` in its
 * deps. It lets the concurrent-navigation race be exercised end to end: `load`
 * is the injected (controllable) fetch; `onCommitted` fires only for a load that
 * is actually applied (i.e. not bailed as stale).
 */
function AsyncHarness(props: {
  load: (id: string) => Promise<void>;
  onCommitted: (id: string) => void;
}) {
  const [params, setParams] = useQueryStates(chatSearchParams);
  const openedRef = useRef<string | null>(null);
  const latestRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadRef = useRef(props.load);
  loadRef.current = props.load;
  const committedRef = useRef(props.onCommitted);
  committedRef.current = props.onCommitted;

  async function select(id: string) {
    latestRef.current = id; // record intent up front (before the guard)
    void setParams({ id }, { history: "push" }); // reflect it in the URL
    if (loading) return; // defer while a load is in flight
    openedRef.current = id;
    setLoading(true);
    try {
      await loadRef.current(id);
      if (latestRef.current !== id) return; // stale — a newer navigation won
      committedRef.current(id);
    } finally {
      setLoading(false);
    }
  }
  const selectRef = useRef(select);
  selectRef.current = select;

  useEffect(() => {
    const action = resolveConversationUrlAction({
      urlId: params.id,
      loadedId: openedRef.current,
      authSettled: true,
      isSignedIn: false,
      envGroupsHasLoaded: false,
    });
    if (action.kind === "open") void selectRef.current(action.id);
  }, [params.id, loading]);

  return createElement(
    "button",
    { onClick: () => void selectRef.current("conv-2") },
    "go",
  );
}

function wrapper(
  searchParams: Record<string, string>,
  onUrlUpdate?: (e: UrlUpdateEvent) => void,
) {
  return ({ children }: { children: ReactNode }) =>
    createElement(NuqsTestingAdapter, { searchParams, onUrlUpdate, hasMemory: true, children });
}

afterEach(() => cleanup());

describe("conversation URL open/navigate (#3068)", () => {
  it("opens the conversation named in ?id= on mount (deep link / reload)", async () => {
    const onOpen = mock((_id: string) => {});
    render(
      createElement(Harness, {
        authSettled: true,
        // self-hosted: no groups fetch to wait on — must still open.
        isSignedIn: false,
        envGroupsHasLoaded: false,
        onOpen,
        onClear: () => {},
      }),
      { wrapper: wrapper({ id: "conv-1" }) },
    );
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("conv-1"));
  });

  it("reflects a navigation in the URL and opens the new conversation", async () => {
    const onOpen = mock((_id: string) => {});
    const onUrlUpdate = mock((_e: UrlUpdateEvent) => {});
    const { getByText } = render(
      createElement(Harness, {
        authSettled: true,
        isSignedIn: true,
        envGroupsHasLoaded: true,
        onOpen,
        onClear: () => {},
      }),
      { wrapper: wrapper({}, onUrlUpdate) },
    );
    fireEvent.click(getByText("go"));
    await waitFor(() =>
      expect(onUrlUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          queryString: expect.stringContaining("id=conv-2"),
        }),
      ),
    );
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("conv-2"));
  });

  it("does not open while a signed-in user's groups fetch is still pending", async () => {
    const onOpen = mock((_id: string) => {});
    render(
      createElement(Harness, {
        authSettled: true,
        isSignedIn: true,
        envGroupsHasLoaded: false,
        onOpen,
        onClear: () => {},
      }),
      { wrapper: wrapper({ id: "conv-1" }) },
    );
    // Give the effect a tick; it must stay in "noop" until groups settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("commits only the latest conversation when a newer ?id= arrives mid-load", async () => {
    // Regression guard for the concurrent-nav race (both bots): deep-link conv-1
    // with a load that hangs, navigate to conv-2 while it's in flight, then let
    // conv-1 resolve. The stale conv-1 result must be discarded and only conv-2
    // committed — exercising the in-flight defer, the `loading`-dep re-drive,
    // and the post-await stale bail together. Drop any one and this fails.
    let resolveFirst: () => void = () => {};
    const firstLoad = new Promise<void>((res) => {
      resolveFirst = res;
    });
    const committed = mock((_id: string) => {});
    const load = (id: string) =>
      id === "conv-1" ? firstLoad : Promise.resolve();
    const { getByText } = render(
      createElement(AsyncHarness, { load, onCommitted: committed }),
      { wrapper: wrapper({ id: "conv-1" }) },
    );
    fireEvent.click(getByText("go")); // navigate to conv-2 mid-load
    resolveFirst(); // conv-1's load resolves late — must bail as stale
    await waitFor(() => expect(committed).toHaveBeenCalledWith("conv-2"));
    expect(committed).not.toHaveBeenCalledWith("conv-1");
  });
});

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
    authSettled: true,
    isSignedIn: true,
    envGroupsHasLoaded: true,
    ...overrides,
  };
}

describe("resolveConversationUrlAction", () => {
  it("waits until auth is settled", () => {
    expect(
      resolveConversationUrlAction(input({ urlId: "conv-1", authSettled: false })),
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

/**
 * Coverage for the `?prompt=` prefill on the unified chat surface (#3081). The
 * hosted `WorkspaceShell` delivers a query through `?prompt=` (`deliverPrompt`);
 * `AtlasChat`'s prefill effect must (a) put the text in the composer and
 * (b) clear `?prompt=` WITHOUT clobbering `?id=` — nuqs merges keys, and the
 * conversation deep link must survive a prompt delivery. As with the #3068 URL
 * tests, this drives the REAL `chatSearchParams` parser through a real nuqs
 * adapter and mirrors the component's effect rather than mounting the whole chat.
 */
function PromptHarness(props: { onPrefill: (text: string) => void }) {
  const [params, setParams] = useQueryStates(chatSearchParams);
  const lastPrefilledRef = useRef<string | null>(null);
  const onPrefillRef = useRef(props.onPrefill);
  onPrefillRef.current = props.onPrefill;
  useEffect(() => {
    const text = params.prompt;
    if (!text) return;
    if (text === lastPrefilledRef.current) return;
    lastPrefilledRef.current = text;
    onPrefillRef.current(text);
    void setParams({ prompt: "" });
  }, [params.prompt, setParams]);
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "id" }, params.id),
    createElement("span", { "data-testid": "prompt" }, params.prompt),
  );
}

describe("?prompt= prefill (#3081)", () => {
  it("prefills the composer from ?prompt= and clears it, preserving ?id=", async () => {
    const onPrefill = mock((_text: string) => {});
    const { getByTestId } = render(createElement(PromptHarness, { onPrefill }), {
      wrapper: wrapper({ id: "conv-1", prompt: "What's our GMV?" }),
    });

    // The text reaches the composer.
    await waitFor(() => expect(onPrefill).toHaveBeenCalledWith("What's our GMV?"));
    // `?prompt=` is cleared back to its default…
    await waitFor(() => expect(getByTestId("prompt").textContent).toBe(""));
    // …while the conversation deep link survives the clear (nuqs merges keys).
    expect(getByTestId("id").textContent).toBe("conv-1");
  });

  it("does not prefill when ?prompt= is absent", async () => {
    const onPrefill = mock((_text: string) => {});
    render(createElement(PromptHarness, { onPrefill }), {
      wrapper: wrapper({ id: "conv-1" }),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(onPrefill).not.toHaveBeenCalled();
  });

  it("keeps the conversation-open resolver independent of the new prompt key", () => {
    // The additive `prompt` key must not perturb the #3068 open/clear decision,
    // which reads only `id`.
    expect(chatSearchParams.prompt).toBeDefined();
    expect(
      resolveConversationUrlAction({
        urlId: "conv-9",
        loadedId: null,
        authSettled: true,
        isSignedIn: false,
        envGroupsHasLoaded: false,
      }),
    ).toEqual({ kind: "open", id: "conv-9" });
  });
});
