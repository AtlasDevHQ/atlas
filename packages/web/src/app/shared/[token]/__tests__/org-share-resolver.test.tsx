import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import type { ConversationFetchResult } from "../share-result";
import type { SharedConversation } from "../../lib";

// next/link needs no router for a plain anchor render — stub it to the bare <a>.
void mock.module("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));
// The shared view renders assistant turns through the chat Markdown component,
// which lazy-loads a syntax highlighter; stub it so the view renders in the
// test DOM. It is the module's only export.
void mock.module("@/ui/components/chat/markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

// Drive the client resolution from a module-level mutable. Factory stays sync
// (async mock.module factories deadlock under bun:test) and mocks ALL exports.
let mockResolve: () => Promise<ConversationFetchResult> = () =>
  Promise.resolve({ ok: false, reason: "login-required" });
function setResult(result: ConversationFetchResult) {
  mockResolve = () => Promise.resolve(result);
}
void mock.module("../org-share-client", () => ({
  resolveOrgShareClient: () => mockResolve(),
  hashShareTokenClient: async () => "deadbeefdeadbeef",
}));

import { OrgShareResolver } from "../org-share-resolver";

const TOKEN = "abc123def456ghi789jkl";

function convo(over: Partial<SharedConversation> = {}): SharedConversation {
  return {
    title: "Quarterly Revenue Q&A",
    surface: "web",
    createdAt: "2026-04-01T00:00:00.000Z",
    messages: [
      { role: "user", content: "Top customers?", createdAt: "2026-04-01T00:00:00.000Z" },
      { role: "assistant", content: "Acme leads.", createdAt: "2026-04-01T00:00:01.000Z" },
    ],
    ...over,
  };
}

// #4719 — the client-side org-share resolution branch, at the component seam:
// the resolver must render the SAME success/error surfaces the SSR path does,
// with the #4690 login/membership split now driven by the viewer's real session.
describe("OrgShareResolver (conversation, #4719)", () => {
  afterEach(() => {
    cleanup();
    // Restore the default resolver so a never-resolving pin (the loading-state
    // test) can't leak into later tests.
    setResult({ ok: false, reason: "login-required" });
  });

  test("success: renders the shared conversation view for an authenticated org member", async () => {
    setResult({ ok: true, data: convo() });
    render(<OrgShareResolver token={TOKEN} />);
    expect(await screen.findByText("Quarterly Revenue Q&A")).toBeDefined();
    expect(screen.getByText("Top customers?")).toBeDefined();
  });

  test("login-required: renders the auth wall with the login redirect back to the share", async () => {
    setResult({ ok: false, reason: "login-required" });
    render(<OrgShareResolver token={TOKEN} />);
    const login = await screen.findByText("Log in");
    expect(login.closest("a")?.getAttribute("href")).toBe(
      `/login?redirect=${encodeURIComponent(`/shared/${TOKEN}`)}`,
    );
  });

  test("membership-required: explains the org requirement and NEVER offers a login CTA", async () => {
    setResult({ ok: false, reason: "membership-required" });
    render(<OrgShareResolver token={TOKEN} />);
    expect(
      await screen.findByText(/don’t have access to this conversation/i),
    ).toBeDefined();
    const loginHrefs = screen
      .queryAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => h.startsWith("/login"));
    expect(loginHrefs).toEqual([]);
  });

  test("embed variant success renders the framable embed view, not the standalone page", async () => {
    setResult({ ok: true, data: convo() });
    render(<OrgShareResolver token={TOKEN} variant="embed" />);
    // EmbedView renders the heading visually hidden and no "Try Atlas free" CTA
    // (embed contract: attributable, never pushy).
    expect(await screen.findByText("Top customers?")).toBeDefined();
    expect(screen.queryByText("Try Atlas free")).toBeNull();
  });

  test("embed variant keeps the #4690 split: login-required gets the sign-in copy, no links", async () => {
    setResult({ ok: false, reason: "login-required" });
    render(<OrgShareResolver token={TOKEN} variant="embed" />);
    expect(
      await screen.findByText(/sign in to atlas to view it/i),
    ).toBeDefined();
    const internalLinks = screen
      .queryAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => !h.startsWith("https://www.useatlas.dev"));
    expect(internalLinks).toEqual([]);
  });

  test("embed variant renders the navigation-free membership copy", async () => {
    setResult({ ok: false, reason: "membership-required" });
    render(<OrgShareResolver token={TOKEN} variant="embed" />);
    expect(
      await screen.findByText(/organization you’re not a member of/i),
    ).toBeDefined();
    const internalLinks = screen
      .queryAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => !h.startsWith("https://www.useatlas.dev"));
    expect(internalLinks).toEqual([]);
  });

  test("shows an accessible resolving state while the client fetch is in flight", () => {
    // Never-resolving promise pins the loading state.
    mockResolve = () => new Promise(() => {});
    render(<OrgShareResolver token={TOKEN} />);
    expect(screen.getByRole("status")).toBeDefined();
  });
});
