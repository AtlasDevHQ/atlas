/**
 * The Zoom source-id contract (#4965) — the half #4967's webhook writer is
 * being built against in parallel.
 *
 * These assertions are a CONTRACT BETWEEN TWO BRANCHES, not a unit test of a
 * string join. The poll path and the webhook path write into one idempotent
 * episode store keyed `(workspace_id, source, source_id)`, and episodes are
 * append-only — so two writers that disagree about the id duplicate every
 * recording they race on, with no upsert to converge them afterwards. The
 * format is pinned to LITERALS here for the same reason `sources.test.ts` pins
 * the stored source kind: comparing the builder to a constant that moves with
 * it would be self-referential agreement.
 */

import { describe, expect, it } from "bun:test";
import {
  ZOOM_MAX_HOSTS,
  isTranscriptFile,
  parseZoomTranscriptsConfig,
  zoomEpisodeSourceId,
} from "@atlas/api/lib/brain/ingest/zoom/config";

const UUID = "4kd8sZTiSHagYbwYtLpMRA==";
const FILE_ID = "a7f3c1e2-4b5d-6789-0abc-def123456789";

describe("the Zoom source-id contract", () => {
  it("is `<meetingUuid>:<recordingFileId>`, byte for byte", () => {
    expect(zoomEpisodeSourceId(UUID, FILE_ID)).toBe(
      "4kd8sZTiSHagYbwYtLpMRA==:a7f3c1e2-4b5d-6789-0abc-def123456789",
    );
  });

  it("keys on the meeting INSTANCE and the FILE, so neither collapses the other", () => {
    // Two occurrences of a recurring meeting share a meeting NUMBER but have
    // different uuids. Keying on the number would collapse every occurrence
    // into one episode and silently drop all but the first.
    const other = "9xY2bQpLTz6aHcWvNmKdRg==";
    expect(zoomEpisodeSourceId(UUID, FILE_ID)).not.toBe(zoomEpisodeSourceId(other, FILE_ID));
    // And one meeting instance genuinely holds several transcripts when the
    // host stopped and restarted the recording. Keying on the uuid alone would
    // drop every segment after the first as a duplicate.
    const secondFile = "b8e4d2f3-5c6e-7890-1bcd-ef2345678901";
    expect(zoomEpisodeSourceId(UUID, FILE_ID)).not.toBe(zoomEpisodeSourceId(UUID, secondFile));
  });

  it("REFUSES a percent-encoded uuid — the encoding trap that would split the two writers", () => {
    // The poll path double-encodes a uuid to put it in a URL path; the webhook
    // path never does, because it arrives in a JSON body. If either normalised
    // before storing, the two writers would mint different ids for the same
    // recording and duplicate every meeting whose uuid contains `/`, `+` or `=`
    // — which is most of them. Refusing at the builder is what stops a caller
    // "helpfully" encoding first.
    expect(() => zoomEpisodeSourceId("4kd8sZTiSHagYbwYtLpMRA%3D%3D", FILE_ID)).toThrow(
      /percent-encoded/,
    );
    expect(() => zoomEpisodeSourceId("4kd8sZTiSHagYbwYtLpMRA%253D%253D", FILE_ID)).toThrow(
      /percent-encoded/,
    );
    // And the message must name the RAW-value rule, or an author who hit it
    // would reasonably conclude the uuid itself was bad.
    expect(() => zoomEpisodeSourceId("a%2Fb", FILE_ID)).toThrow(/RAW uuid/);
  });

  it("ACCEPTS the base64 characters that make the encoding trap real", () => {
    // `/`, `+` and `=` are exactly the characters that force double-encoding on
    // the request path. They must survive into the stored id untouched — a
    // builder that rejected or stripped them would break the common case while
    // looking like a validation win.
    expect(zoomEpisodeSourceId("ab/cd+ef==", FILE_ID)).toBe(`ab/cd+ef==:${FILE_ID}`);
    expect(zoomEpisodeSourceId("/leadingSlash==", FILE_ID)).toBe(`/leadingSlash==:${FILE_ID}`);
  });

  it("THROWS rather than returning a sentinel for a malformed half", () => {
    // Every caller is a WRITER and the value is half of the dedupe tuple. A
    // malformed id would not fail on the way in — it would land a row the other
    // writer never dedupes against.
    for (const badUuid of ["", "has spaces", "colon:inside", "under_score"]) {
      expect(() => zoomEpisodeSourceId(badUuid, FILE_ID)).toThrow();
    }
    for (const badFileId of ["", "not-a-guid", "a7f3c1e2-4b5d-6789-0abc", UUID]) {
      expect(() => zoomEpisodeSourceId(UUID, badFileId)).toThrow(/not a GUID/);
    }
  });
});

describe("isTranscriptFile — the OTHER half both writers must share", () => {
  it("selects only the timestamped transcript, never Zoom's AI artifacts", () => {
    // `SUMMARY` and `TIMELINE` are Zoom's INFERENCE, not what was said.
    // Ingesting one would put a vendor's paraphrase into an evidence store and
    // let the brain cite it as a quote.
    expect(isTranscriptFile({ fileType: "TRANSCRIPT" })).toBe(true);
    for (const other of ["SUMMARY", "TIMELINE", "CC", "MP4", "M4A", "CHAT"]) {
      expect([other, isTranscriptFile({ fileType: other })]).toEqual([other, false]);
    }
  });

  it("is case-insensitive, so a vendor-side case change is not a silent empty pass", () => {
    // The failure this guards is the worst shape available: every transcript
    // stops being recognised, and the sync reports a clean, empty, entirely
    // green pass.
    expect(isTranscriptFile({ fileType: "transcript" })).toBe(true);
    expect(isTranscriptFile({ fileType: "Transcript" })).toBe(true);
  });

  it("tolerates a missing file type without guessing", () => {
    expect(isTranscriptFile({ fileType: null })).toBe(false);
  });
});

describe("parseZoomTranscriptsConfig", () => {
  it("requires an account id and reports the repair", () => {
    for (const config of [null, {}, { accountId: "" }, { accountId: "   " }, { accountId: 42 }]) {
      const parsed = parseZoomTranscriptsConfig(config as Record<string, unknown> | null);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/account id/i);
    }
  });

  it("reads an ABSENT host list as the whole account, and says so", () => {
    // This is the one place the Zoom config reads OPPOSITE to its Slack
    // neighbour, where an empty channel list is an error. Pinned because the
    // two sit in the same directory and the difference is easy to "fix".
    for (const config of [{ accountId: "acc1" }, { accountId: "acc1", hosts: null }]) {
      const parsed = parseZoomTranscriptsConfig(config);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.hosts).toEqual([]);
    }
  });

  it("REFUSES a malformed host list rather than silently widening to the account", () => {
    // Narrowing silently would produce a source that reports success while
    // never reading a host the admin believes is connected; WIDENING silently
    // would ingest every meeting in the company because a scope field was
    // malformed. Both directions are wrong, so it refuses.
    for (const hosts of ["not-an-array", [42], [""], [null]]) {
      const parsed = parseZoomTranscriptsConfig({ accountId: "acc1", hosts });
      expect(parsed.ok).toBe(false);
    }
  });

  it("dedupes, trims, and bounds the host list", () => {
    const parsed = parseZoomTranscriptsConfig({
      accountId: "  acc1  ",
      hosts: [" u1 ", "u1", "u2"],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.accountId).toBe("acc1");
      expect(parsed.hosts).toEqual(["u1", "u2"]);
    }
    const over = parseZoomTranscriptsConfig({
      accountId: "acc1",
      hosts: Array.from({ length: ZOOM_MAX_HOSTS + 1 }, (_, i) => `u${i}`),
    });
    expect(over.ok).toBe(false);
  });
});
