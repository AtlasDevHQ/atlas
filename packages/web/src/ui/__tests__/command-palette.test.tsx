import { describe, expect, test, afterEach, mock } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CommandPalette } from "../components/chat/command-palette";

function noop() {}

function renderPalette() {
  return render(
    <CommandPalette
      conversations={[]}
      onNewChat={noop}
      onSelectConversation={noop}
      onOpenPromptLibrary={noop}
      onOpenSchemaExplorer={noop}
    />,
  );
}

describe("CommandPalette keyboard contracts", () => {
  afterEach(() => {
    cleanup();
    mock.restore();
  });

  test("⌘K toggles the dialog open and closed", async () => {
    renderPalette();

    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });

    // Pressing ⌘K again must CLOSE the palette — a regression to
    // setOpen(true) would trap users inside it.
    act(() => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  test("Ctrl-K also opens the palette (Linux/Windows alias)", async () => {
    renderPalette();

    act(() => {
      fireEvent.keyDown(document, { key: "K", ctrlKey: true });
    });
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
  });

  test("? opens the palette when no field is focused", async () => {
    renderPalette();

    act(() => {
      fireEvent.keyDown(document.body, { key: "?" });
    });
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
  });

  test("? does NOT open the palette while typing in an input", async () => {
    // Mount an input alongside the palette so the keydown event has a
    // realistic field target — the chat input is the canonical case.
    const { container } = render(
      <div>
        <input data-testid="chat-input" />
        <CommandPalette
          conversations={[]}
          onNewChat={noop}
          onSelectConversation={noop}
          onOpenPromptLibrary={noop}
          onOpenSchemaExplorer={noop}
        />
      </div>,
    );

    const input = container.querySelector('[data-testid="chat-input"]') as HTMLInputElement;
    input.focus();

    act(() => {
      fireEvent.keyDown(input, { key: "?" });
    });

    // Give React a tick to render any state change, then assert nothing opened.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
