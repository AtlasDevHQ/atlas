/**
 * Coverage for `ByotInstallModal` after #4203 converged the BYOT credential
 * form onto the shared {@link FormDialog} primitive (it was an inline card
 * form before). Three things this locks:
 *
 *   1. Slack's single-field submit POSTs `{ botToken }` to the legacy
 *      `/api/v1/admin/integrations/slack/byot` endpoint and fires the success
 *      callbacks (the wire contract the old inline form held).
 *   2. A failed submit surfaces the server's message through FormDialog's
 *      shared root-error banner — BYOT formats via `friendlyErrorOrNull` (a
 *      DIFFERENT formatter than the REST/curated `installFormErrorMessage`),
 *      so the "an error-surface fix reaches all of them" criterion needs its
 *      own assertion here, not just for the other two dialogs.
 *   3. Discord's dynamic 3-field schema (`botToken` / `applicationId` /
 *      `publicKey`) — the multi-field path Slack's degenerate single-field
 *      case can't reach — builds a 3-key required schema and body.
 *
 * The mutation hook needs `<AtlasProvider>` (API URL) + `<QueryClientProvider>`
 * (TanStack cache); `globalThis.fetch` is mocked so no backend is hit.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AtlasProvider } from "@/ui/context";
import { ByotInstallModal } from "../byot-form";

const testConfig = {
  apiUrl: "http://localhost:3001",
  isCrossOrigin: false,
  authClient: {
    signIn: { email: async () => ({}) },
    signUp: { email: async () => ({}) },
    signOut: async () => {},
    useSession: () => ({ data: null, isPending: false }),
  },
};

function render(ui: ReactElement): RenderResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <AtlasProvider config={testConfig}>{ui}</AtlasProvider>
    </QueryClientProvider>,
  );
}

function fillField(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) throw new Error(`field #${id} not rendered`);
  fireEvent.change(el, { target: { value } });
}

function connectButton(): HTMLButtonElement {
  const btn = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ).find((b) => b.textContent?.trim() === "Connect");
  if (!btn) throw new Error("Connect button not rendered");
  return btn;
}

describe("ByotInstallModal", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; method: string; body: unknown }>;
  let nextResponse: () => Response;

  beforeEach(() => {
    fetchCalls = [];
    nextResponse = () =>
      new Response(JSON.stringify({ message: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      fetchCalls.push({ url, method, body });
      return Promise.resolve(nextResponse());
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  test("Slack: submit POSTs { botToken } and fires success callbacks", async () => {
    const onSuccess = mock(() => undefined);
    const onOpenChange = mock(() => undefined);
    render(
      <ByotInstallModal
        slug="slack"
        name="Slack"
        open
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
      />,
    );

    await act(async () => {
      fillField("slack-botToken", "xoxb-test-token");
    });
    await act(async () => {
      fireEvent.click(connectButton());
    });

    await waitFor(() => {
      const call = fetchCalls.find(
        (c) => c.method === "POST" && c.url.endsWith("/api/v1/admin/integrations/slack/byot"),
      );
      expect(call).toBeDefined();
      expect(call?.body).toEqual({ botToken: "xoxb-test-token" });
    });
    expect(onSuccess).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("surfaces a failed submit through FormDialog's shared error banner", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ message: "Invalid bot token" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    const onSuccess = mock(() => undefined);
    render(
      <ByotInstallModal
        slug="slack"
        name="Slack"
        open
        onOpenChange={() => undefined}
        onSuccess={onSuccess}
      />,
    );

    await act(async () => {
      fillField("slack-botToken", "bad");
    });
    await act(async () => {
      fireEvent.click(connectButton());
    });

    expect(await screen.findByText("Invalid bot token")).toBeDefined();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  test("Discord: 3-field submit POSTs all three keys", async () => {
    render(
      <ByotInstallModal
        slug="discord"
        name="Discord"
        open
        onOpenChange={() => undefined}
        onSuccess={() => undefined}
      />,
    );

    await act(async () => {
      fillField("discord-botToken", "disc-token");
      fillField("discord-applicationId", "app-123");
      fillField("discord-publicKey", "pub-key");
    });
    await act(async () => {
      fireEvent.click(connectButton());
    });

    await waitFor(() => {
      const call = fetchCalls.find(
        (c) => c.method === "POST" && c.url.endsWith("/api/v1/admin/integrations/discord/byot"),
      );
      expect(call).toBeDefined();
      expect(call?.body).toEqual({
        botToken: "disc-token",
        applicationId: "app-123",
        publicKey: "pub-key",
      });
    });
  });
});
