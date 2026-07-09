import { describe, it, expect, mock, afterEach } from "bun:test";
import { render, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryStates } from "nuqs";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";
import {
  chatSearchParams,
  resolveConversationUrlAction,
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
