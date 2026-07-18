import { describe, expect, mock, test } from "bun:test";
import type { ConversationFetchResult } from "../share-result";
import type { SharedConversation } from "../../lib";

// Drive both RSCs' data fetch from a module-level mutable. Factory stays sync
// (async mock.module factories deadlock under bun:test) and mocks ALL exports
// of `../fetch`.
let mockResult: ConversationFetchResult = { ok: false, reason: "login-required" };
void mock.module("../fetch", () => ({
  fetchSharedConversation: () => Promise.resolve(mockResult),
  fetchSharedConversationRaw: () => Promise.resolve(mockResult),
  buildForwardHeaders: () => ({}),
  hashShareToken: () => "deadbeefdeadbeef",
}));

import SharedConversationPage from "../page";
import SharedConversationEmbedPage from "../embed/page";
import { OrgShareResolver } from "../org-share-resolver";
import { ErrorShell } from "../../error-shell";
import { SharedConversationView } from "../view";
import { EmbedView, EmbedErrorView } from "../embed/view";

const TOKEN = "abc123def456ghi789jkl";

function convo(): SharedConversation {
  return {
    title: "Quarterly Revenue Q&A",
    surface: "web",
    createdAt: "2026-04-01T00:00:00.000Z",
    messages: [
      { role: "user", content: "Top customers?", createdAt: "2026-04-01T00:00:00.000Z" },
    ],
  };
}

function pageProps() {
  return { params: Promise.resolve({ token: TOKEN }) };
}

function embedProps() {
  return {
    params: Promise.resolve({ token: TOKEN }),
    searchParams: Promise.resolve({}),
  };
}

// #4719 — the load-bearing decision of the PR, at the page seam: ONLY the two
// auth-wall reasons hand off to the client-side org-share resolver; every
// other failure (and success) stays pure SSR. Regressing this branch back to
// its pre-PR shape would dead-end every SaaS cross-origin org share on a false
// login wall while all the component/mapper tests stay green.
describe("shared conversation page hand-off (#4719)", () => {
  test("auth-wall reasons mount the client resolver", async () => {
    for (const reason of ["login-required", "membership-required"] as const) {
      mockResult = { ok: false, reason };
      const el = await SharedConversationPage(pageProps());
      expect(el.type).toBe(OrgShareResolver);
      expect(el.props.token).toBe(TOKEN);
    }
  });

  test("non-auth failures render the SSR error shell, not the resolver", async () => {
    for (const reason of ["not-found", "expired", "server-error", "network-error"] as const) {
      mockResult = { ok: false, reason };
      const el = await SharedConversationPage(pageProps());
      expect(el.type).toBe(ErrorShell);
      expect(el.props.sharePath).toBe(`/shared/${TOKEN}`);
    }
  });

  test("success stays pure SSR — renders the shared view directly", async () => {
    mockResult = { ok: true, data: convo() };
    const el = await SharedConversationPage(pageProps());
    expect(el.type).toBe(SharedConversationView);
    expect(el.props.convo.title).toBe("Quarterly Revenue Q&A");
  });
});

describe("shared conversation embed hand-off (#4719)", () => {
  test("auth-wall reasons mount the client resolver in embed variant", async () => {
    mockResult = { ok: false, reason: "membership-required" };
    const el = await SharedConversationEmbedPage(embedProps());
    expect(el.type).toBe(OrgShareResolver);
    expect(el.props.variant).toBe("embed");
    expect(el.props.token).toBe(TOKEN);
  });

  test("non-auth failures render the navigation-free embed error view", async () => {
    mockResult = { ok: false, reason: "expired" };
    const el = await SharedConversationEmbedPage(embedProps());
    expect(el.type).toBe(EmbedErrorView);
    expect(el.props.reason).toBe("expired");
  });

  test("success renders the embed view", async () => {
    mockResult = { ok: true, data: convo() };
    const el = await SharedConversationEmbedPage(embedProps());
    expect(el.type).toBe(EmbedView);
  });
});
