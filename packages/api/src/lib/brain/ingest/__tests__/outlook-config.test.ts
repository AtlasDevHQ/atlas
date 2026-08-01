/**
 * The Outlook source-id contract and install config (#4966).
 *
 * The source-id assertions are a CONTRACT, not a unit test of a string trim.
 * `(workspace_id, source, source_id)` is the dedupe tuple and episodes are
 * append-only, so the id decides whether one email to five colleagues becomes
 * ONE episode or five — and there is no upsert to converge them afterwards. The
 * format is pinned to LITERALS for the same reason `sources.test.ts` pins the
 * stored source kind: comparing the builder to a constant that moves with it
 * would be self-referential agreement.
 */

import { describe, expect, it } from "bun:test";
import {
  MAX_INTERNET_MESSAGE_ID_LENGTH,
  OUTLOOK_MAX_MAILBOXES,
  normalizeInternetMessageId,
  outlookEpisodeSourceId,
  parseOutlookMailConfig,
} from "@atlas/api/lib/brain/ingest/outlook/config";

const RAW = "<AS8PR07MB8241A0F@AS8PR07MB8241.eurprd07.prod.outlook.com>";
const BARE = "AS8PR07MB8241A0F@AS8PR07MB8241.eurprd07.prod.outlook.com";

describe("the Outlook source-id contract", () => {
  it("is the RFC 5322 Message-ID with its angle brackets stripped, byte for byte", () => {
    expect(outlookEpisodeSourceId(RAW)).toBe(BARE);
  });

  it("⭐ is IDENTICAL for every mailbox's copy — the cross-mailbox dedupe", () => {
    // The whole design. Graph's own `message.id` differs per mailbox AND is
    // re-minted when a message moves between folders; the Message-ID is issued
    // once by the sending system and is the same in every copy everywhere.
    // Since the dedupe tuple has no mailbox column, keying on Graph's id would
    // ingest one 5-recipient email as five episodes with byte-identical bodies
    // — and the extractor would then derive the same fact five times, each
    // citing its own "independent" evidence.
    //
    // Modelled as three reads of the same header from three mailboxes: the
    // input to the builder is the header, and nothing else is in scope.
    const senderCopy = outlookEpisodeSourceId(RAW);
    const inboxCopy = outlookEpisodeSourceId(RAW);
    const archivedCopy = outlookEpisodeSourceId(`  ${RAW}  `);
    expect([inboxCopy, archivedCopy]).toEqual([senderCopy, senderCopy]);
  });

  it("strips exactly ONE enclosing pair, never brackets from the middle", () => {
    expect(normalizeInternetMessageId("<a@b.com>")).toBe("a@b.com");
    // A doubly-wrapped value is malformed, not something to unwrap twice: after
    // one strip it still holds brackets, and a stored key must not contain them
    // inconsistently or the re-verifier's `$filter` never matches.
    expect(normalizeInternetMessageId("<<a@b.com>>")).toBeNull();
    // Two ids concatenated into one header — a real mail-server bug, and
    // guessing which one to keep would attribute evidence to the wrong message.
    expect(normalizeInternetMessageId("<a@b.com> <c@d.com>")).toBeNull();
  });

  it("accepts a BARE id, because not every mail system emits the brackets", () => {
    // Round-trips unchanged, which is why `fetchMessageByInternetMessageId`
    // tries both the bracketed and bare `$filter` spellings — a bare id stored
    // bare would never match a bracketed query, and the audience would then fail
    // re-verification every cycle forever.
    expect(normalizeInternetMessageId(BARE)).toBe(BARE);
  });

  it("does NOT lowercase — RFC 5322's id-left is case-sensitive", () => {
    // Two ids differing only in case are genuinely two messages. Lowercasing
    // would collapse them and silently drop one as a duplicate.
    expect(normalizeInternetMessageId("<AbC@example.com>")).toBe("AbC@example.com");
    expect(outlookEpisodeSourceId("<AbC@example.com>")).not.toBe(
      outlookEpisodeSourceId("<abc@example.com>"),
    );
  });

  it("refuses whitespace, control bytes, and an over-length id", () => {
    // Each of these would reach a stored key AND an `audience:` grant token,
    // both of which are read back by `LIKE` scans that a stray byte defeats.
    expect(normalizeInternetMessageId("<a b@c.com>")).toBeNull();
    expect(normalizeInternetMessageId("<a\tb@c.com>")).toBeNull();
    expect(normalizeInternetMessageId("<a\nb@c.com>")).toBeNull();
    // Written as \u ESCAPES, never as literal bytes. A raw control character
    // in a test file is invisible in review and a formatter is free to eat it,
    // which would leave this assertion passing for the whitespace reason above
    // while the control-byte guard went untested. (Written literally the first
    // time; caught because grep stopped matching the file.)
    expect(normalizeInternetMessageId("<a\u0000b@c.com>")).toBeNull();
    expect(normalizeInternetMessageId("<a\u001fb@c.com>")).toBeNull();
    expect(normalizeInternetMessageId("<a\u007fb@c.com>")).toBeNull();
    const tooLong = `${"a".repeat(MAX_INTERNET_MESSAGE_ID_LENGTH)}@x.com`;
    expect(normalizeInternetMessageId(tooLong)).toBeNull();
    // …and one character under the bound still passes, so the guard is a bound
    // rather than a blanket refusal of long ids.
    expect(normalizeInternetMessageId("a".repeat(MAX_INTERNET_MESSAGE_ID_LENGTH))).toBe(
      "a".repeat(MAX_INTERNET_MESSAGE_ID_LENGTH),
    );
  });

  it("refuses a blank or absent id rather than minting a colliding key", () => {
    for (const bad of ["", "   ", "<>", "< >", null, undefined]) {
      expect([String(bad), normalizeInternetMessageId(bad as string | null)]).toEqual([
        String(bad),
        null,
      ]);
    }
  });

  it("THROWS from the builder, so a bad key cannot reach storage silently", () => {
    // The builder is the backstop, not the gate: callers still deciding whether
    // a message is identifiable ask `normalizeInternetMessageId` and skip on
    // null. Reaching the builder with an unusable value is a programmer error,
    // and a sentinel would land a row no other writer ever dedupes against.
    expect(() => outlookEpisodeSourceId("")).toThrow(/usable RFC 5322 Message-ID/);
    // The message must warn off the obvious "fix", or the next author reaches
    // straight for the per-mailbox id and re-introduces the duplication.
    expect(() => outlookEpisodeSourceId("<a b@c>")).toThrow(/never fall back to Graph's own/i);
  });
});

describe("the Outlook install config", () => {
  const ok = { tenantId: "contoso.onmicrosoft.com", mailboxes: ["a@contoso.com"] };

  it("parses a well-formed config", () => {
    expect(parseOutlookMailConfig(ok)).toEqual({
      ok: true,
      tenantId: "contoso.onmicrosoft.com",
      mailboxes: ["a@contoso.com"],
    });
  });

  it("⭐ REFUSES an absent mailbox list — there is no spelling that means the whole tenant", () => {
    // The one place this connector deliberately inverts its Zoom sibling, where
    // an absent `hosts` list means the whole account. Graph's application
    // `Mail.Read` is tenant-wide with no narrower form and Atlas cannot see
    // whether an admin narrowed the app with an ApplicationAccessPolicy, so a
    // missing field widening to "every mailbox in the company" is the one
    // failure this source must not have — and a missing field is exactly what a
    // half-finished install form submits.
    for (const config of [{ tenantId: ok.tenantId }, { tenantId: ok.tenantId, mailboxes: null }]) {
      const parsed = parseOutlookMailConfig(config);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.error).toMatch(/no setting that means every mailbox/i);
    }
    // An EMPTY list is refused too — otherwise the "required" field is
    // satisfiable by a value that means nothing.
    const empty = parseOutlookMailConfig({ tenantId: ok.tenantId, mailboxes: [] });
    expect(empty.ok).toBe(false);
  });

  it("REFUSES a malformed entry rather than silently narrowing the scope", () => {
    // Skipping a bad entry would produce a source that reports success while
    // never reading a mailbox the admin believes is connected — the same
    // argument the Slack and Zoom configs make for refusing rather than
    // dropping.
    for (const mailboxes of [["a@contoso.com", 42], ["a@contoso.com", ""], [null]]) {
      expect(parseOutlookMailConfig({ tenantId: ok.tenantId, mailboxes }).ok).toBe(false);
    }
  });

  it("dedupes mailboxes case-insensitively, keeping the admin's spelling", () => {
    // An address is case-insensitive to a mail system, so two spellings are one
    // mailbox walked twice — double the vendor spend and double the audience
    // writes for no extra coverage. The FIRST spelling is kept because it is
    // what Graph was given and what its errors will name.
    const parsed = parseOutlookMailConfig({
      tenantId: ok.tenantId,
      mailboxes: ["Ann@contoso.com", "ann@contoso.com", " ANN@contoso.com "],
    });
    expect(parsed).toEqual({
      ok: true,
      tenantId: ok.tenantId,
      mailboxes: ["Ann@contoso.com"],
    });
  });

  it("refuses a missing tenant id and an over-cap mailbox list", () => {
    expect(parseOutlookMailConfig({ mailboxes: ["a@b.com"] }).ok).toBe(false);
    expect(parseOutlookMailConfig({ tenantId: "  ", mailboxes: ["a@b.com"] }).ok).toBe(false);
    expect(parseOutlookMailConfig(null).ok).toBe(false);
    const tooMany = Array.from({ length: OUTLOOK_MAX_MAILBOXES + 1 }, (_, i) => `u${i}@contoso.com`);
    const parsed = parseOutlookMailConfig({ tenantId: ok.tenantId, mailboxes: tooMany });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain(String(OUTLOOK_MAX_MAILBOXES));
  });

  it("gives every refusal an admin-facing repair, because it lands in sync state", () => {
    // These strings surface in `knowledge_sync_state.error`, which is where an
    // operator reads them. "Invalid config" would be true and useless.
    for (const config of [null, { mailboxes: ["a@b.com"] }, { tenantId: "t" }]) {
      const parsed = parseOutlookMailConfig(config as Record<string, unknown> | null);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.error).toMatch(/re-install/i);
    }
  });
});
