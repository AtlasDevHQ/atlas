/**
 * #3749 — transport-level resume routing. Unit-covers `resolveResumeRequest`,
 * the pure decision that re-targets a marked chat send to the durable-resume
 * endpoint (`POST /chat/{conversationId}/resume`, no body) and otherwise falls
 * through to a normal `/chat` request.
 */
import { describe, expect, test } from "bun:test";
import {
  resolveResumeRequest,
  buildChatRequestBody,
  nextCapturedId,
  ATLAS_RESUME_MARKER,
} from "@/ui/hooks/use-atlas-transport";

const API = "https://api.example.com";

describe("resolveResumeRequest (#3749)", () => {
  test("re-targets a marked send to the conversation's resume endpoint with an empty body", () => {
    const result = resolveResumeRequest(API, { [ATLAS_RESUME_MARKER]: true }, "conv-1");
    expect(result).toEqual({
      api: `${API}/api/v1/chat/conv-1/resume`,
      body: {},
    });
  });

  test("sends NO body to the resume endpoint (the server re-enters from its checkpoint)", () => {
    const result = resolveResumeRequest(API, { [ATLAS_RESUME_MARKER]: true }, "conv-1");
    // The resume route takes the conversation id in the path and ignores the
    // body; sending the marker (or anything) through would be a leak / no-op.
    expect(Object.keys(result!.body)).toHaveLength(0);
  });

  test("falls through (null) for a normal send without the marker", () => {
    expect(resolveResumeRequest(API, undefined, "conv-1")).toBeNull();
    expect(resolveResumeRequest(API, { temperature: 0.7 }, "conv-1")).toBeNull();
  });

  test("falls through (null) for a marked send with no conversation to resume against", () => {
    // Defensive: the affordance is gated on a mounted conversation, but a marker
    // with no conversation id must not POST to `/chat//resume`.
    expect(resolveResumeRequest(API, { [ATLAS_RESUME_MARKER]: true }, null)).toBeNull();
  });

  test("treats a falsy marker value as not-a-resume", () => {
    expect(resolveResumeRequest(API, { [ATLAS_RESUME_MARKER]: false }, "conv-1")).toBeNull();
  });
});

describe("buildChatRequestBody (#3749)", () => {
  const MSGS = [{ id: "m1", role: "user" }];

  test("always sets messages and never forwards a per-call body / marker", () => {
    const body = buildChatRequestBody(MSGS, {});
    expect(body).toEqual({ messages: MSGS });
    // No marker, no `trigger`, no stray per-call fields leak through.
    expect(ATLAS_RESUME_MARKER in body).toBe(false);
  });

  test("omits routing scope fields when absent (server falls back to the row)", () => {
    const body = buildChatRequestBody(MSGS, {
      conversationId: null,
      connectionId: null,
      connectionGroupId: null,
      routingMode: null,
    });
    expect(body).toEqual({ messages: MSGS });
  });

  test("includes routing scope fields when present", () => {
    const body = buildChatRequestBody(MSGS, {
      conversationId: "conv-1",
      connectionId: "conn-1",
      connectionGroupId: "grp-1",
      routingMode: "auto",
    });
    expect(body).toEqual({
      messages: MSGS,
      conversationId: "conv-1",
      connectionId: "conn-1",
      connectionGroupId: "grp-1",
      routingMode: "auto",
    });
  });

  test("ALWAYS sends the REST exclude-set / focus when present — even [] / null (re-include / clear)", () => {
    const body = buildChatRequestBody(MSGS, {
      restExcludedDatasourceIds: [],
      restFocusDatasourceId: null,
    });
    // The #3066/#3067 invariant: an empty set / null clear must reach the server,
    // not be dropped (which would inherit the stale row value — the #3073 bug).
    expect(body.restExcludedDatasourceIds).toEqual([]);
    expect(body.restFocusDatasourceId).toBeNull();
  });

  test("omits the REST fields when the getter is absent (SDK/API callers)", () => {
    const body = buildChatRequestBody(MSGS, {
      restExcludedDatasourceIds: undefined,
      restFocusDatasourceId: undefined,
    });
    expect("restExcludedDatasourceIds" in body).toBe(false);
    expect("restFocusDatasourceId" in body).toBe(false);
  });

  test("copies the exclude-set (doesn't alias the caller's array)", () => {
    const src = ["a", "b"];
    const body = buildChatRequestBody(MSGS, { restExcludedDatasourceIds: src });
    expect(body.restExcludedDatasourceIds).toEqual(["a", "b"]);
    expect(body.restExcludedDatasourceIds).not.toBe(src);
  });

  test("#3895 — ALWAYS sends groupReach when present, even null (widen to All sources)", () => {
    // A focus → its group id reaches the server; a widen → an explicit null
    // reaches it too, so the row's stale Focus is cleared (the #3073 bug class).
    expect(buildChatRequestBody(MSGS, { groupReach: "g_prod" }).groupReach).toBe("g_prod");
    const widened = buildChatRequestBody(MSGS, { groupReach: null });
    expect("groupReach" in widened).toBe(true);
    expect(widened.groupReach).toBeNull();
  });

  test("#3895 — omits groupReach when the getter is absent (SDK/API callers inherit the row)", () => {
    const body = buildChatRequestBody(MSGS, { groupReach: undefined });
    expect("groupReach" in body).toBe(false);
  });
});

describe("nextCapturedId (#3749)", () => {
  test("returns the header value when it's new", () => {
    expect(nextCapturedId("run-1", null)).toBe("run-1");
    expect(nextCapturedId("run-2", "run-1")).toBe("run-2");
  });

  test("returns null when the header is absent (don't fire the callback)", () => {
    expect(nextCapturedId(null, "run-1")).toBeNull();
  });

  test("returns null when unchanged — dedupes a multi-request stream", () => {
    // A multi-request stream returns the same x-run-id on every chunk's response;
    // the callback must fire once, not on every chunk.
    expect(nextCapturedId("run-1", "run-1")).toBeNull();
  });
});
