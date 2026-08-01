/**
 * The Microsoft Graph REST surface (#4966).
 *
 * Two things in this module cannot be reached from any other suite, and both
 * are safety-critical, so they carry this file:
 *
 *   - `parseOutlookMessage`'s `headersComplete`, which keys on the PRESENCE of
 *     the participant keys rather than on their contents. Every audience test
 *     injects an already-parsed message, so a mutation that read an omitted
 *     `ccRecipients` as an empty list would stay green everywhere else — while
 *     in production it would REVOKE every Cc'd person on the next reconcile.
 *   - `isGraphUrl`, the host pin on `@odata.nextLink`. Graph hands back a full
 *     URL to follow; that is vendor-supplied data this process then fetches.
 *
 * `fetch` is stubbed on `globalThis` per test and restored after — the only
 * seam available for a module whose whole job is HTTP, and confined to this
 * file so no other suite can observe it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  fetchGraphAccessToken,
  fetchMailbox,
  fetchMailboxMessagesPage,
  fetchMessageByInternetMessageId,
  isGraphUrl,
  parseOutlookMessage,
  toReadError,
} from "@atlas/api/lib/brain/ingest/outlook/api";

const REAL_FETCH = globalThis.fetch;

beforeEach(() => {
  // A test that forgets to `stub()` would otherwise make a REAL outbound
  // request to graph.microsoft.com from CI. Failing loudly by name is strictly
  // better than a flaky network call nobody attributes.
  globalThis.fetch = (() => {
    throw new Error("unstubbed fetch — call stub() first");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

/** Stub `fetch` with canned JSON responses, one per call in order. */
function stub(bodies: unknown[], init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: URL[] = [];
  let index = 0;
  globalThis.fetch = (async (input: string | URL) => {
    calls.push(new URL(String(input)));
    const body = bodies[Math.min(index++, bodies.length - 1)];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }) as typeof fetch;
  return calls;
}

const ADDRESS = (address: string) => ({ emailAddress: { address, name: null } });

describe("parseOutlookMessage — the mass-revocation guard", () => {
  const complete = {
    id: "AAMkAGx",
    internetMessageId: "<a@contoso.com>",
    from: ADDRESS("sender@contoso.com"),
    toRecipients: [ADDRESS("to@contoso.com")],
    ccRecipients: [],
  };

  it("⭐ keys headersComplete on the KEYS, not the contents", async () => {
    // THE line this file exists for. An empty `ccRecipients` is a complete
    // answer (this message has no Cc); an ABSENT one is not an answer at all.
    // Reading absent as empty does not merely under-grant — the same set is
    // what `reconcileAudienceMembership` DELETES against, so it revokes every
    // Cc'd person.
    //
    // MUTATION THIS CATCHES: `headersComplete: true` unconditionally, or
    // `toAddressList` returning `[]` instead of `null` for a missing key. Every
    // audience and client test injects an already-parsed message, so both stay
    // green across the rest of the suite.
    expect(parseOutlookMessage(complete)?.headersComplete).toBe(true);
    for (const missing of ["from", "toRecipients", "ccRecipients"]) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[missing];
      expect([missing, parseOutlookMessage(partial)?.headersComplete]).toEqual([missing, false]);
    }
    // A key that is PRESENT but not an array is drift, not emptiness — same
    // answer, and for the same reason.
    for (const bad of [null, "nope", {}, 42]) {
      expect(parseOutlookMessage({ ...complete, ccRecipients: bad })?.headersComplete).toBe(false);
    }
    // …and an empty array really is complete, or a Cc-less message could never
    // be ingested at all.
    expect(parseOutlookMessage({ ...complete, toRecipients: [] })?.headersComplete).toBe(true);
  });

  it("lower-cases addresses at the boundary — they are a JOIN KEY", () => {
    // `resolvePrincipals` joins these against `user.email`. Leaving the vendor's
    // casing would make `Ann@x.com` and `ann@x.com` two principals and resolve
    // neither reliably.
    const parsed = parseOutlookMessage({
      ...complete,
      from: ADDRESS("Sender@Contoso.COM"),
      toRecipients: [ADDRESS("  To@Contoso.com  ")],
    });
    expect(parsed?.from?.address).toBe("sender@contoso.com");
    expect(parsed?.toRecipients[0].address).toBe("to@contoso.com");
  });

  it("carries NO bcc and NO conversationId, even when Graph sends them", () => {
    // Structural, not merely intended: `grant.ts` decides BCC is ignored for the
    // whole email class, and the cheapest way to keep a later edit from quietly
    // honouring it is for the value never to be carried. Likewise
    // `conversationId` — a thread id the connector never reads cannot end up in
    // a stored key by accident.
    const parsed = parseOutlookMessage({
      ...complete,
      bccRecipients: [ADDRESS("secret@contoso.com")],
      conversationId: "AAQkAG",
    });
    expect(JSON.stringify(parsed)).not.toContain("secret@contoso.com");
    expect(JSON.stringify(parsed)).not.toContain("AAQkAG");
  });

  it("refuses a body Graph did not convert to text", () => {
    // The `Prefer` header asks Exchange for plain text and it honours it — but a
    // response that came back HTML anyway must NOT be stored as if it were text.
    // A stored HTML blob puts markup into an evidence body that every reader,
    // and the extractor, treats as what somebody wrote.
    expect(
      parseOutlookMessage({ ...complete, body: { contentType: "text", content: "hi" } })?.bodyText,
    ).toBe("hi");
    // ⭐ And it must be DISTINGUISHABLE from a message that simply has no body.
    // Collapsing the two lets the client compose and store the header block
    // alone, producing an episode that reads as a complete message while the
    // thing somebody actually wrote is missing. The client-side guard is tested
    // in `outlook-client.test.ts`, but it is driven by THIS flag — and every
    // client test injects an already-parsed message, so without this assertion
    // a mutation here stays green across the whole suite.
    //
    // MUTATION THIS CATCHES: `bodyUnreadable: false` in the refusal arm.
    const refused = parseOutlookMessage({
      ...complete,
      body: { contentType: "html", content: "<p>hi</p>" },
    });
    expect([refused?.bodyText, refused?.bodyUnreadable]).toEqual([null, true]);
    // A message with genuinely no body is NOT flagged — it is complete evidence
    // (a subject-only "approved — EOM") and must stay ingestable.
    const absent = parseOutlookMessage(complete);
    expect([absent?.bodyText, absent?.bodyUnreadable]).toEqual([null, false]);
    // An empty-string body is absence, not refusal.
    const blank = parseOutlookMessage({ ...complete, body: { contentType: "text", content: "" } });
    expect([blank?.bodyText, blank?.bodyUnreadable]).toEqual([null, false]);
  });

  it("returns null for a non-object entry rather than a half-built message", () => {
    for (const bad of [null, "nope", 42, []]) {
      expect(parseOutlookMessage(bad)).toBeNull();
    }
  });
});

describe("isGraphUrl — the pin on vendor-supplied URLs", () => {
  it("accepts only https on graph.microsoft.com exactly", () => {
    expect(isGraphUrl("https://graph.microsoft.com/v1.0/users/x/messages?$skiptoken=abc")).toBe(true);
    // A trailing dot resolves identically while failing a naive equality check.
    expect(isGraphUrl("https://graph.microsoft.com./v1.0/users")).toBe(true);
  });

  it("REFUSES the lookalikes a suffix test would wave through", () => {
    // MUTATION THIS CATCHES: `hostname.endsWith(".microsoft.com")`, which is the
    // natural-looking spelling and admits the first two of these.
    for (const bad of [
      "https://notgraph.microsoft.com/v1.0/users",
      "https://graph.microsoft.com.evil.test/v1.0/users",
      "https://evil.test/graph.microsoft.com",
      "http://graph.microsoft.com/v1.0/users",
      "https://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
      "not a url",
      "",
    ]) {
      expect([bad, isGraphUrl(bad)]).toEqual([bad, false]);
    }
  });

  it("refuses to FOLLOW an off-host nextLink, and reports it as a failed read", async () => {
    // Reported as a failure rather than as "last page": an unfollowed link means
    // the rest of the window was never read, and the difference between "last
    // page" and "would not follow" is the difference between advancing the
    // cursor and freezing it.
    stub([{ value: [], "@odata.nextLink": "https://evil.test/steal" }]);
    const page = await fetchMailboxMessagesPage("tok", {
      mailboxId: "mb",
      since: "2026-01-01T00:00:00Z",
      pageSize: 10,
    });
    expect(page.ok).toBe(false);
    expect(page.ok === false && page.error).toBe("transport");
  });
});

describe("toReadError — the vocabulary an admin reads", () => {
  it("splits 403 into missing consent vs an ApplicationAccessPolicy exclusion", () => {
    // The two are repaired in DIFFERENT Microsoft consoles — Entra vs Exchange —
    // so collapsing them sends an admin to re-consent a permission that was
    // already there.
    expect(toReadError(403, null, '{"error":{"code":"ErrorAccessDenied"}}').error).toBe(
      "mailbox_denied",
    );
    expect(toReadError(403, null, '{"error":{"message":"ApplicationAccessPolicy"}}').error).toBe(
      "mailbox_denied",
    );
    expect(toReadError(403, null, '{"error":{"message":"missing scope"}}').error).toBe(
      "missing_scope",
    );
  });

  it("maps an unlicensed mailbox's 400 rather than letting it read as a bad request", () => {
    expect(toReadError(400, null, "MailboxNotEnabledForRESTAPI").error).toBe("mailbox_unavailable");
    // A different 400 is NOT swallowed into that arm.
    expect(toReadError(400, null, "something else").error).toBe("http_400");
  });

  it("parses Retry-After in both legal spellings, and neither as zero", () => {
    expect(toReadError(429, "120", "").retryAfterSeconds).toBe(120);
    expect(toReadError(429, "nonsense", "").retryAfterSeconds).toBeNull();
    // Null means "use your own schedule" to the engine's backoff. Returning 0
    // would make it retry immediately against a vendor that just said stop.
    expect(toReadError(429, null, "").retryAfterSeconds).toBeNull();
  });

  it("maps 401 to a credential fault and keeps an unmapped status verbatim", () => {
    expect(toReadError(401, null, "").error).toBe("invalid_auth");
    expect(toReadError(503, null, "").error).toBe("http_503");
  });
});

describe("fetchGraphAccessToken", () => {
  it("refuses a tenant id that could traverse the identity endpoint's path", async () => {
    // The value arrives from an install form and is interpolated into a PATH on
    // login.microsoftonline.com. It never reaches `fetch`, so the stub's
    // throw-on-unstubbed is what proves no request was made.
    const result = await fetchGraphAccessToken({
      tenantId: "common/oauth2/v2.0/token/../../..",
      clientId: "c",
      clientSecret: "s",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("invalid_auth");
  });

  it("puts the secret in the BODY, never the query string", async () => {
    const calls = stub([{ access_token: "tok" }]);
    await fetchGraphAccessToken({ tenantId: "contoso.com", clientId: "cid", clientSecret: "shhh" });
    // A URL is a candidate for any log line that records request URLs, which
    // CLAUDE.md's no-secrets rule covers.
    expect(calls[0].toString()).not.toContain("shhh");
    expect(calls[0].search).toBe("");
  });

  it("does NOT blame the credential for an unreadable 200", async () => {
    // A 200 whose body is not JSON is Microsoft-side (a proxy interstitial).
    // Collapsing it into `invalid_auth` sends the admin to rotate a secret that
    // was fine.
    stub(["<html>maintenance</html>"]);
    const result = await fetchGraphAccessToken({ tenantId: "c.com", clientId: "c", clientSecret: "s" });
    expect(result.ok === false && result.error).toBe("transport");
  });

  it("maps Microsoft's 400 credential codes onto invalid_auth", async () => {
    // A bad client id answers 400 `unauthorized_client`, not 401. Left
    // unmapped it falls through to `http_400` and reads as an Atlas bug.
    stub([{ error: "unauthorized_client" }], { status: 400 });
    const result = await fetchGraphAccessToken({ tenantId: "c.com", clientId: "c", clientSecret: "s" });
    expect(result.ok === false && result.error).toBe("invalid_auth");
  });
});

describe("fetchMessageByInternetMessageId — the re-verifier's read", () => {
  const found = {
    value: [
      {
        id: "AAMkAGx",
        internetMessageId: "<a@contoso.com>",
        from: ADDRESS("s@contoso.com"),
        toRecipients: [ADDRESS("t@contoso.com")],
        ccRecipients: [],
      },
    ],
  };

  it("queries the BRACKETED form first — Graph stores the raw header", async () => {
    const calls = stub([found]);
    const result = await fetchMessageByInternetMessageId("tok", "mb", "a@contoso.com");
    expect(result.ok && result.message?.internetMessageId).toBe("<a@contoso.com>");
    expect(calls[0].searchParams.get("$filter")).toBe("internetMessageId eq '<a@contoso.com>'");
  });

  it("falls back to the BARE form, which is not belt-and-braces", async () => {
    // `normalizeInternetMessageId` strips brackets only when both are present,
    // so a sending system that emitted a bare id round-trips bare and the
    // bracketed filter misses it. The caller reads a zero-result lookup as
    // "unreadable" and aborts — so without this fallback that message's
    // audience fails EVERY cycle, which is the permanent-failure class #4971's
    // starvation then spreads to the whole workspace.
    //
    // MUTATION THIS CATCHES: dropping the second loop iteration.
    const calls = stub([{ value: [] }, found]);
    const result = await fetchMessageByInternetMessageId("tok", "mb", "a@contoso.com");
    expect(result.ok && result.message).not.toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1].searchParams.get("$filter")).toBe("internetMessageId eq 'a@contoso.com'");
  });

  it("escapes an apostrophe by DOUBLING it, per OData", () => {
    // RFC 5322 `atext` includes `'`, so an apostrophe in a Message-ID is legal.
    // A backslash escape (the instinct from every other language) produces a
    // malformed filter, Graph answers 400, and the audience fails every cycle
    // over one character in a value nobody prints.
    const calls = stub([{ value: [] }]);
    return fetchMessageByInternetMessageId("tok", "mb", "o'brien@contoso.com").then(() => {
      expect(calls[0].searchParams.get("$filter")).toBe(
        "internetMessageId eq '<o''brien@contoso.com>'",
      );
    });
  });

  it("reports a genuine miss as ok-with-null, distinct from a read failure", async () => {
    // The caller must be able to tell "Graph answered and the mailbox does not
    // have it" from "Graph did not answer" — both abort, but only one of them
    // means the message is gone.
    stub([{ value: [] }]);
    const miss = await fetchMessageByInternetMessageId("tok", "mb", "gone@contoso.com");
    expect(miss).toEqual({ ok: true, message: null });

    stub([{ error: {} }], { status: 429, headers: { "retry-after": "30" } });
    const failure = await fetchMessageByInternetMessageId("tok", "mb", "x@contoso.com");
    expect(failure.ok).toBe(false);
    expect(failure.ok === false && failure.error).toBe("ratelimited");
  });
});

describe("fetchMailbox / fetchMailboxMessagesPage", () => {
  it("resolves a mailbox to its object id, refusing a user with none", async () => {
    stub([{ id: "8f14e45f", userPrincipalName: "a@contoso.com", mail: "a@contoso.com" }]);
    const ok = await fetchMailbox("tok", "a@contoso.com");
    expect(ok.ok && ok.mailbox.id).toBe("8f14e45f");

    // An object with no id cannot key an audience token or a cursor entry, so
    // it is a read failure rather than a mailbox with a blank id.
    stub([{ userPrincipalName: "a@contoso.com" }]);
    const bad = await fetchMailbox("tok", "a@contoso.com");
    expect(bad.ok).toBe(false);
  });

  it("filters out drafts and orders ascending — both are correctness, not taste", async () => {
    // Ascending because an interrupted DESCENDING walk leaves a hole in the
    // middle of its window, and in an append-only store a hole and an absence
    // look identical forever. Drafts because a draft was never sent, so nobody
    // received it and there is no audience to derive.
    const calls = stub([{ value: [] }]);
    await fetchMailboxMessagesPage("tok", {
      mailboxId: "mb",
      since: "2026-01-01T00:00:00Z",
      pageSize: 25,
    });
    expect(calls[0].searchParams.get("$orderby")).toBe("receivedDateTime asc");
    expect(calls[0].searchParams.get("$filter")).toBe(
      "isDraft eq false and receivedDateTime ge 2026-01-01T00:00:00Z",
    );
    expect(calls[0].searchParams.get("$top")).toBe("25");
  });

  it("counts unreadable entries as dropped rather than skipping them silently", async () => {
    // They sit INSIDE the range the pass is about to mark covered, so advancing
    // past them would be a silent loss; the client truncates on `dropped > 0`.
    stub([{ value: [null, "nope", { id: "x", internetMessageId: "<a@b>", from: ADDRESS("a@b"), toRecipients: [], ccRecipients: [] }] }]);
    const page = await fetchMailboxMessagesPage("tok", {
      mailboxId: "mb",
      since: "2026-01-01T00:00:00Z",
      pageSize: 10,
    });
    expect(page.ok && page.dropped).toBe(2);
    expect(page.ok && page.messages).toHaveLength(1);
  });

  it("treats an absent `value` as drift, not as an empty page", async () => {
    // Unlike Zoom's recordings read, where an absent key legitimately means
    // "nothing in this window", Graph spells an empty collection `{value: []}`.
    // So an absent key is drift either way and must truncate the walk.
    stub([{}]);
    const page = await fetchMailboxMessagesPage("tok", {
      mailboxId: "mb",
      since: "2026-01-01T00:00:00Z",
      pageSize: 10,
    });
    expect(page.ok && page.dropped).toBe(1);
  });
});
