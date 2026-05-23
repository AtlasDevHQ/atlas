import { describe, expect, test, afterEach, mock } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// Module mocks must be set up before importing the component under test —
// otherwise the real `next/navigation` runs at import time and the
// `AppRouterContext` invariant throws during render.
mock.module("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

mock.module("@/ui/hooks/use-platform-admin-guard", () => ({
  useUserRole: () => "admin",
  usePlatformAdminGuard: () => ({ blocked: false }),
}));

mock.module("@/ui/hooks/use-deploy-mode", () => ({
  useDeployMode: () => ({ deployMode: "self-hosted", loading: false }),
}));

mock.module("@/ui/hooks/use-admin-fetch", () => ({
  useAdminFetch: () => ({ data: null, loading: false, error: null, refetch: () => {} }),
  friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

mock.module("@/ui/components/tour/guided-tour", () => ({
  useTourContext: () => null,
}));

const { CommandPalette } = await import("../components/chat/command-palette");

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

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
