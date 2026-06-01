import { describe, it, expect, mock, afterEach } from "bun:test";
import { render, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { createElement, useEffect, useRef, type ReactNode } from "react";
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
  authResolved: boolean;
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
      authResolved: props.authResolved,
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
  }, [params.id, props.authResolved, props.isSignedIn, props.envGroupsHasLoaded]);
  return createElement(
    "button",
    { onClick: () => void setParams({ id: "conv-2" }, { history: "push" }) },
    "go",
  );
}

function wrapper(
  searchParams: Record<string, string>,
  onUrlUpdate?: (e: UrlUpdateEvent) => void,
) {
  return ({ children }: { children: ReactNode }) =>
    createElement(
      NuqsTestingAdapter,
      { searchParams, onUrlUpdate, hasMemory: true },
      children,
    );
}

afterEach(() => cleanup());

describe("conversation URL open/navigate (#3068)", () => {
  it("opens the conversation named in ?id= on mount (deep link / reload)", async () => {
    const onOpen = mock((_id: string) => {});
    render(
      createElement(Harness, {
        authResolved: true,
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
        authResolved: true,
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
        authResolved: true,
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
});
