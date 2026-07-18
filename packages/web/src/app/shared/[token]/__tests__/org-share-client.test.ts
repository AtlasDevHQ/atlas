import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { _resetApiUrl, applyRegionSignal } from "@/lib/api-url";
import { hashShareTokenClient, resolveOrgShareClient } from "../org-share-client";

const TOKEN = "abc123def456ghi789jkl";

const okConversation = {
  title: "Revenue Analysis",
  surface: "web",
  createdAt: "2026-03-12T00:00:00Z",
  shareMode: "org",
  messages: [
    { role: "user", content: "What were our top customers?", createdAt: "2026-03-12T00:00:00Z" },
  ],
};

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = mock(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return calls;
}

describe("hashShareTokenClient (#4719)", () => {
  test("matches the server-side node:crypto mirror (first 16 hex of SHA-256)", async () => {
    const nodeHash = createHash("sha256").update(TOKEN).digest("hex").slice(0, 16);
    expect(await hashShareTokenClient(TOKEN)).toBe(nodeHash);
  });
});

// #4719 — the three client-side org-share resolution outcomes from the issue's
// acceptance criteria: success, login-required, membership-required. The
// mapping is shared verbatim with the SSR fetch (`mapSharedConversationResponse`),
// so the #4690 split holds identically — now evaluated against the viewer's
// REAL session because the browser fetch carries credentials.
describe("resolveOrgShareClient (conversation, #4719)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    _resetApiUrl();
  });

  test("success: a credentialed viewer in the owning org gets the conversation", async () => {
    const calls = stubFetch(200, okConversation);
    const result = await resolveOrgShareClient(TOKEN);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.title).toBe("Revenue Analysis");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`/api/public/conversations/${TOKEN}`);
    expect(calls[0]!.init?.cache).toBe("no-store");
  });

  test("sends credentials: include against a cross-origin (regional) API base", async () => {
    // Force the cross-origin topology deterministically via the regional signal
    // (the same override `getApiUrl()` folds in for every client fetch).
    expect(applyRegionSignal("eu", "https://api-eu.example.test")).toBe(true);
    const calls = stubFetch(200, okConversation);

    await resolveOrgShareClient(TOKEN);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://api-eu.example.test/api/public/conversations/${TOKEN}`,
    );
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  test("maps a 403 with error:auth_required (no session) to login-required", async () => {
    stubFetch(403, { error: "auth_required" });
    expect(await resolveOrgShareClient(TOKEN)).toEqual({ ok: false, reason: "login-required" });
  });

  test("maps a 403 with error:forbidden (authenticated, wrong org) to membership-required", async () => {
    stubFetch(403, { error: "forbidden" });
    expect(await resolveOrgShareClient(TOKEN)).toEqual({
      ok: false,
      reason: "membership-required",
    });
  });

  test("maps a 404 to not-found and a 410 to expired (revoked/expired org links)", async () => {
    stubFetch(404, {});
    expect(await resolveOrgShareClient(TOKEN)).toEqual({ ok: false, reason: "not-found" });
    stubFetch(410, {});
    expect(await resolveOrgShareClient(TOKEN)).toEqual({ ok: false, reason: "expired" });
  });

  test("never logs the raw token — logs only its hash — on a network error (#4317)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    const result = await resolveOrgShareClient(TOKEN);
    expect(result).toEqual({ ok: false, reason: "network-error" });

    for (const call of errSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
    }
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toContain(await hashShareTokenClient(TOKEN));
    errSpy.mockRestore();
  });

  test("a 200 whose body isn't JSON resolves to server-error — never a rejection", async () => {
    // Locks the never-rejects contract `OrgShareResolver` builds its two-state
    // model on, through the client seam.
    globalThis.fetch = mock(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not json");
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    await expect(resolveOrgShareClient(TOKEN)).resolves.toEqual({
      ok: false,
      reason: "server-error",
    });
    errSpy.mockRestore();
  });
});
