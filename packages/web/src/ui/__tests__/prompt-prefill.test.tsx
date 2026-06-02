import { describe, it, expect, mock, afterEach } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import { createElement, useEffect, useRef, type ReactNode } from "react";
import { useQueryStates } from "nuqs";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { chatSearchParams, resolveConversationUrlAction } from "../components/search-params";

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

function wrapper(searchParams: Record<string, string>) {
  return ({ children }: { children: ReactNode }) =>
    createElement(NuqsTestingAdapter, { searchParams, hasMemory: true }, children);
}

afterEach(() => cleanup());

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
    await new Promise((r) => setTimeout(r, 20));
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
