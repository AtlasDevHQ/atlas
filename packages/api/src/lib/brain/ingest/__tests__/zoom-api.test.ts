/**
 * The Zoom REST surface (#4965).
 *
 * The panel's finding that produced this file: `api.ts` had ZERO tests, and it
 * holds the single line that makes the mass-revocation state unrepresentable —
 * `fetchMeetingParticipantsPage` refusing a non-array `participants` instead of
 * reading it as an empty roster. Every other test in this slice INJECTS the
 * roster, so a mutation there stayed green across the whole suite.
 *
 * `fetch` is stubbed on `globalThis` per test and restored after. That is the
 * only seam available for a module whose whole job is HTTP, and it is confined
 * to this file so no other suite can observe it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  encodeMeetingUuidForPath,
  fetchAccountRecordingsPage,
  fetchMeetingParticipantsPage,
  fetchTranscriptText,
  fetchZoomAccessToken,
} from "@atlas/api/lib/brain/ingest/zoom/api";

const REAL_FETCH = globalThis.fetch;

beforeEach(() => {
  // A test that forgets to `stub()` would otherwise make a REAL outbound
  // request to api.zoom.us from CI. Failing loudly by name is strictly better
  // than a flaky network call nobody attributes.
  globalThis.fetch = (() => {
    throw new Error("unstubbed fetch — call stub() first");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

/** Stub `fetch` with one canned JSON response. */
function stub(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    calls.push(new URL(String(input)));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }) as typeof fetch;
  return calls;
}

describe("fetchMeetingParticipantsPage — the mass-revocation guard", () => {
  it("REFUSES a non-array `participants` rather than reading it as an empty roster", async () => {
    // THE line this file exists for. An empty-but-complete roster reconciles
    // the audience to nobody and revokes every member — and because episodes
    // are gated rather than deleted, that is indistinguishable from correct
    // fail-closed behaviour from every surface.
    //
    // MUTATION THIS CATCHES: returning `{ok: true, participants: []}` on shape
    // drift. Every injected-roster test in this slice stays green under it.
    for (const shape of [{}, { participants: null }, { participants: "nope" }, { participants: {} }]) {
      const result = await (async () => {
        stub(shape);
        return fetchMeetingParticipantsPage("tok", "uuid==", { pageSize: 300 });
      })();
      expect([JSON.stringify(shape), result.ok]).toEqual([JSON.stringify(shape), false]);
    }
  });

  it("reads a genuinely empty roster as ok — the two must stay distinguishable", async () => {
    stub({ participants: [] });
    const result = await fetchMeetingParticipantsPage("tok", "uuid==", { pageSize: 300 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.participants).toEqual([]);
  });

  it("double-encodes the meeting uuid in the path — the other half of the encoding trap", async () => {
    // `config.ts` pins that the STORED id is raw; this pins that the REQUEST is
    // encoded. Without both halves the contract is only half-guarded, and the
    // symptom of getting this wrong is a 404 on exactly the meetings whose uuid
    // contains a slash.
    const calls = stub({ participants: [] });
    await fetchMeetingParticipantsPage("tok", "ab/cd+ef==", { pageSize: 300 });
    expect(calls[0].pathname).toContain("ab%252Fcd%252Bef%253D%253D");
    expect(encodeMeetingUuidForPath("ab/cd+ef==")).toBe("ab%252Fcd%252Bef%253D%253D");
  });
});

describe("error mapping — each code drives a different admin sentence", () => {
  const cases: [number, string, string][] = [
    [429, "{}", "ratelimited"],
    [401, "{}", "invalid_auth"],
    // 403 is overloaded: a missing SCOPE is repaired in the Zoom app config, a
    // PLAN limit needs a plan change. Same status, different repair.
    [403, '{"message":"Invalid access token, does not contain scopes"}', "missing_scope"],
    [403, '{"message":"This account does not have this feature"}', "plan_required"],
    [404, "{}", "not_found"],
    [500, "{}", "http_500"],
  ];
  for (const [status, body, expected] of cases) {
    it(`maps ${status} (${expected})`, async () => {
      stub(body, { status });
      const result = await fetchAccountRecordingsPage("tok", {
        accountId: "acc",
        from: "2026-03-01",
        to: "2026-03-02",
        pageSize: 1,
      });
      expect([status, result.ok ? "ok" : result.error]).toEqual([status, expected]);
    });
  }

  it("parses Retry-After as seconds, and treats junk as null rather than zero", async () => {
    // `0` would tell the engine's backoff to retry immediately against a vendor
    // that just asked us to stop.
    stub("{}", { status: 429, headers: { "retry-after": "42" } });
    const withSeconds = await fetchAccountRecordingsPage("tok", {
      accountId: "acc",
      from: "2026-03-01",
      to: "2026-03-02",
      pageSize: 1,
    });
    expect(withSeconds.ok ? null : withSeconds.retryAfterSeconds).toBe(42);

    stub("{}", { status: 429, headers: { "retry-after": "soon" } });
    const junk = await fetchAccountRecordingsPage("tok", {
      accountId: "acc",
      from: "2026-03-01",
      to: "2026-03-02",
      pageSize: 1,
    });
    expect(junk.ok ? "ok" : junk.retryAfterSeconds).toBeNull();
  });
});

describe("fetchZoomAccessToken", () => {
  it("does NOT blame the credential for an unreadable 200 body", async () => {
    // A proxy interstitial or maintenance page is Zoom-side. Reporting it as
    // `invalid_auth` sends the admin to rotate a secret that was fine — the
    // "no misleading error messages" rule in its most expensive form.
    stub("<html>maintenance</html>");
    const result = await fetchZoomAccessToken({
      accountId: "a",
      clientId: "b",
      clientSecret: "c",
    });
    expect(result.ok ? "ok" : result.error).toBe("transport");
  });

  it("reports a well-formed body with no access_token as invalid_auth", async () => {
    stub({ token_type: "bearer" });
    const result = await fetchZoomAccessToken({
      accountId: "a",
      clientId: "b",
      clientSecret: "c",
    });
    expect(result.ok ? "ok" : result.error).toBe("invalid_auth");
  });

  it("never puts the client secret in the query string", async () => {
    // It goes in a Basic header. A URL is the thing most likely to reach a log
    // line, and CLAUDE.md forbids a secret getting there.
    const calls = stub({ access_token: "tok" });
    await fetchZoomAccessToken({ accountId: "a", clientId: "b", clientSecret: "supersecret" });
    expect(calls[0].search).not.toContain("supersecret");
    expect(calls[0].search).toContain("account_credentials");
  });
});

describe("fetchAccountRecordingsPage — shape-drift accounting", () => {
  it("reads an ABSENT `meetings` key as an empty window, not as drift", async () => {
    // Zoom's shape for "no recordings in this range". Counting it as `dropped`
    // would make every quiet window truncate the walk forever.
    stub({});
    const result = await fetchAccountRecordingsPage("tok", {
      accountId: "acc",
      from: "2026-03-01",
      to: "2026-03-02",
      pageSize: 1,
    });
    expect(result.ok && result.dropped).toBe(0);
  });

  it("counts a PRESENT but unusable shape as dropped, so the caller truncates", async () => {
    // The distinction matters: dropped entries sit inside the window the pass
    // is about to mark covered, so the caller must not advance past them.
    stub({ meetings: "not-an-array" });
    const drift = await fetchAccountRecordingsPage("tok", {
      accountId: "acc",
      from: "2026-03-01",
      to: "2026-03-02",
      pageSize: 1,
    });
    expect(drift.ok && drift.dropped).toBe(1);

    stub({ meetings: [{ topic: "no uuid" }, null, { uuid: "ok==", recording_files: [] }] });
    const partial = await fetchAccountRecordingsPage("tok", {
      accountId: "acc",
      from: "2026-03-01",
      to: "2026-03-02",
      pageSize: 1,
    });
    expect(partial.ok && [partial.dropped, partial.meetings.length]).toEqual([2, 1]);
  });

  it("forwards the window and the page token verbatim", async () => {
    // Untested, these are silent killers: a swapped from/to or a dropped page
    // token makes the account look empty or re-reads page 1 to the page cap.
    const calls = stub({ meetings: [] });
    await fetchAccountRecordingsPage("tok", {
      accountId: "acc 1",
      from: "2026-03-01",
      to: "2026-03-30",
      pageSize: 300,
      nextPageToken: "tk",
    });
    expect(calls[0].pathname).toContain("acc%201");
    expect(calls[0].searchParams.get("from")).toBe("2026-03-01");
    expect(calls[0].searchParams.get("to")).toBe("2026-03-30");
    expect(calls[0].searchParams.get("next_page_token")).toBe("tk");
  });
});

describe("fetchTranscriptText — the SSRF host pin", () => {
  // `download_url` is VENDOR-SUPPLIED DATA that Atlas then fetches WITH THE
  // WORKSPACE BEARER TOKEN ATTACHED. The module header calls the host pin "the
  // stronger half" of the guard, and round 2 found it had no test at all —
  // replacing the condition with `if (false)` survived the whole suite.
  //
  // The pin returns BEFORE any fetch, so the `beforeEach` throwing stub is what
  // proves it: if a refusal ever started fetching, these tests fail by name.

  it("REFUSES a non-Zoom download_url WITHOUT issuing the request", async () => {
    // Asserting only `ok === false` is not enough and this test proved it: with
    // the `beforeEach` throwing stub in place, disabling the pin still yields
    // `ok:false` — via the transport catch — so the mutant SURVIVED. The claim
    // that matters is that no request leaves the box carrying the workspace
    // bearer token, so the stub must SUCCEED and the call count must be zero.
    for (const url of [
      "https://evil.example/x",
      // The classic suffix-confusion payload: `.zoom.us` appears, but as a
      // LABEL inside an attacker-controlled domain.
      "https://zoom.us.attacker.example/x",
      "https://notzoom.us/x",
      "http://zoom.us/x",
      "not a url",
    ]) {
      const calls = stub("WEBVTT\n");
      const result = await fetchTranscriptText("tok", url);
      expect([url, result.ok, calls.length]).toEqual([url, false, 0]);
    }
  });

  it("allows a genuine Zoom host, and DOES issue the request", async () => {
    // The other half — a pin that refused everything would pass the test above.
    const calls = stub("WEBVTT\n");
    const result = await fetchTranscriptText("tok", "https://cdn.zoom.us/rec/x");
    expect([result.ok, calls.length]).toEqual([true, 1]);
  });

  it("refuses an over-cap transcript by Content-Length, BEFORE buffering it", async () => {
    // Round 1 added this and round 2 found it untested. The bound exists so a
    // shared region process is not at the mercy of a vendor's response size.
    stub("x", { headers: { "content-length": "99999999" } });
    const result = await fetchTranscriptText("tok", "https://zoom.us/rec/x", 1024);
    expect(result.ok ? "ok" : result.error).toBe("too_large");
  });

  it("does not refuse a transcript inside the cap", async () => {
    stub("WEBVTT\n", { headers: { "content-length": "12" } });
    const result = await fetchTranscriptText("tok", "https://zoom.us/rec/x", 1024);
    expect(result.ok).toBe(true);
  });
});
