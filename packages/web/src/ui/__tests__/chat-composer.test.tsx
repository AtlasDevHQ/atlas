/**
 * #4295 — the multiline chat composer. Covers the acceptance criteria at the
 * component boundary:
 *   - Enter sends the current value (and never inserts a newline)
 *   - Shift+Enter does NOT send — the default newline insertion is left alone
 *   - Enter mid-IME-composition commits the composition instead of sending
 *   - streaming ⇒ textarea locked, send slot becomes a Stop control
 *   - loadingConversation ⇒ textarea and Send both locked
 *   - empty value ⇒ Enter still prevents the default (no leading newline);
 *     the empty-send no-op guard itself lives in the caller (`handleSend`)
 * Auto-grow is height-measurement driven and is covered by the browser test
 * (e2e/browser/composer-multiline.spec.ts), not here — happy-dom has no layout.
 */
import { describe, expect, test, afterEach, mock } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ChatComposer } from "../components/chat/chat-composer";

afterEach(() => cleanup());

function renderComposer(overrides: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const props = {
    value: "how many companies are there?",
    onValueChange: mock((_v: string) => {}),
    onSend: mock((_text: string) => {}),
    streaming: false,
    loadingConversation: false,
    onStop: mock(() => {}),
    ...overrides,
  };
  const utils = render(<ChatComposer {...props} />);
  const textarea = utils.getByLabelText("Chat message") as HTMLTextAreaElement;
  return { ...utils, props, textarea };
}

describe("ChatComposer (#4295)", () => {
  test("renders a textarea (not an input) with the current value", () => {
    const { textarea } = renderComposer();
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.value).toBe("how many companies are there?");
  });

  test("Enter sends the current value and prevents the default newline", () => {
    const { textarea, props } = renderComposer();
    const notPrevented = fireEvent.keyDown(textarea, { key: "Enter" });
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSend).toHaveBeenCalledWith("how many companies are there?");
    // fireEvent returns false when preventDefault() was called.
    expect(notPrevented).toBe(false);
  });

  test("Shift+Enter does not send and leaves the default alone (newline inserts)", () => {
    const { textarea, props } = renderComposer();
    const notPrevented = fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(props.onSend).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  test("Enter during IME composition commits the composition, not a send", () => {
    const { textarea, props } = renderComposer();
    const notPrevented = fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(props.onSend).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  test("Enter on an empty composer still prevents default (no leading newline)", () => {
    const { textarea, props } = renderComposer({ value: "" });
    const notPrevented = fireEvent.keyDown(textarea, { key: "Enter" });
    expect(notPrevented).toBe(false);
    // The composer delegates; the trim/no-op guard is handleSend's.
    expect(props.onSend).toHaveBeenCalledWith("");
  });

  test("typing forwards the new value through onValueChange", () => {
    const { textarea, props } = renderComposer();
    fireEvent.change(textarea, { target: { value: "line one\nline two" } });
    expect(props.onValueChange).toHaveBeenCalledWith("line one\nline two");
  });

  test("clicking Send submits the current value", () => {
    const { getByLabelText, props } = renderComposer();
    fireEvent.click(getByLabelText("Send"));
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSend).toHaveBeenCalledWith("how many companies are there?");
  });

  test("empty value marks Send aria-disabled (empty-input affordance)", () => {
    const { getByLabelText } = renderComposer({ value: "   " });
    expect(getByLabelText("Send").getAttribute("aria-disabled")).toBe("true");
  });

  test("streaming: textarea is locked and the send slot becomes Stop", () => {
    const { textarea, getByLabelText, queryByLabelText, props } = renderComposer({
      streaming: true,
    });
    expect(textarea.disabled).toBe(true);
    expect(queryByLabelText("Send")).toBeNull();
    const stop = getByLabelText("Stop");
    // type="button" so Stop can never submit the form (#4294).
    expect(stop.getAttribute("type")).toBe("button");
    fireEvent.click(stop);
    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  test("loadingConversation: textarea and Send are both locked (#3068)", () => {
    const { textarea, getByLabelText, props } = renderComposer({
      loadingConversation: true,
    });
    expect(textarea.disabled).toBe(true);
    expect((getByLabelText("Send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(props.onSend).not.toHaveBeenCalled();
  });

  test("iOS no-zoom sizing: text-base at mobile widths, sm:text-sm above", () => {
    const { textarea } = renderComposer();
    expect(textarea.className).toContain("text-base");
    expect(textarea.className).toContain("sm:text-sm");
  });
});
