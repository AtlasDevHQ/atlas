/**
 * No participant digest reaches the log sink (#4966, hardened by #4971).
 *
 * ## Why this is a separate file
 *
 * The property is "X does not reach the log", which only a logger CAPTURE can
 * observe. `outlook/audience.ts` binds its logger at MODULE SCOPE
 * (`const log = createLogger(...)`), so the `mock.module()` has to be registered
 * BEFORE the module is imported — and a static `import` is hoisted above every
 * statement in the file. In `outlook-audience.test.ts`, which imports the module
 * statically, the mock would install after that binding and the capture would
 * stay empty while every assertion passed. Hence: own file, mock first, then a
 * dynamic `await import`.
 *
 * ## Why capture rather than a source-text assertion
 *
 * `expect(source).toContain("redactAudienceDigest(audienceId)")` was the cheaper
 * option and is evadable by renaming a variable or interpolating it into the
 * message string. This asserts the actual bytes handed to the logger.
 *
 * ## What it defends
 *
 * `redactAudienceDigest`'s own unit tests call it directly, so ALL SIX of its
 * call sites could be replaced with the raw `audienceId` and stay green. The
 * digest is an unsalted hash of a sorted address set — an offline-confirmable
 * fingerprint of "did these two correspond" — and this module synthesises
 * positional participant labels precisely to keep that class of thing out of the
 * sink. Shipping the digest there instead would make that pointless.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { emailParticipantsDigest } from "@atlas/api/lib/brain/ingest/grant";

interface LogRecord {
  readonly level: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

const captured: LogRecord[] = [];

function record(level: string) {
  return (fields: unknown, message?: unknown): void => {
    captured.push({
      level,
      fields: (fields ?? {}) as Record<string, unknown>,
      message: String(message ?? ""),
    });
  };
}

// Registered BEFORE the dynamic import below. The factory is SYNCHRONOUS: an
// async `mock.module` factory deadlocks under bun:test.
void mock.module("@atlas/api/lib/logger", () => ({
  createLogger: () => ({
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  }),
  getLogger: () => ({
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  }),
  getRequestContext: () => undefined,
  withRequestContext: (_ctx: unknown, fn: () => unknown) => fn(),
  hashShareToken: (token: string) => token,
  setLogLevel: () => true,
  scrubErrSerializer: (value: unknown) => value,
  scrubLogFormatter: (_level: unknown, fields: unknown) => fields,
  redactPaths: [] as string[],
  ACTOR_KINDS: ["human", "agent", "mcp", "scheduler", "api_key"] as const,
}));

const MAILBOX = "8f14e45f";
const MESSAGE = "a@contoso.com";
const PARTICIPANTS = ["sender@contoso.com", "to@contoso.com", "cc@contoso.com"];
const DIGEST = emailParticipantsDigest(PARTICIPANTS);
const AUDIENCE_ID = `email-message:outlook:${MAILBOX}:${DIGEST}:${MESSAGE}`;
const TOKEN = `audience:${AUDIENCE_ID}`;

/** Every string anywhere in a captured record — fields included, not just the message. */
function allText(entry: LogRecord): string {
  return `${entry.message} ${JSON.stringify(entry.fields)}`;
}

describe("Outlook audience logging never emits a participant digest", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  /**
   * Drive one re-verification pass down a chosen abort path.
   *
   * Each `reason` is one of the branches that logs an audience id, which is the
   * whole set of places a digest could escape.
   */
  async function runPass(
    reason: "read-failed" | "absent" | "digest-mismatch" | "threw" | "unparseable",
  ): Promise<void> {
    const { reverifyOutlookMessageAudiences: reverify } = await import(
      "@atlas/api/lib/brain/ingest/outlook/audience"
    );
    const { REVERIFY_CANDIDATES_SQL, TOUCH_REVERIFY_ATTEMPT_SQL } = await import(
      "@atlas/api/lib/brain/audience/reverify"
    );

    const token = reason === "unparseable" ? "audience:email-message:malformed" : TOKEN;
    type Query = NonNullable<NonNullable<Parameters<typeof reverify>[0]>["query"]>;
    const query: Query = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> => {
      if (sql.includes("workspace_plugins")) {
        return [
          { workspace_id: "ws", install_id: "i", config: { tenantId: "t", mailboxes: ["a@b.com"] } },
        ] as unknown as T[];
      }
      if (sql === TOUCH_REVERIFY_ATTEMPT_SQL) return [] as T[];
      if (sql !== REVERIFY_CANDIDATES_SQL) throw new Error(`unexpected statement: ${sql}`);
      return [{ token, has_members: true }] as unknown as T[];
    };

    await reverify({
      query,
      isEnabled: () => true,
      resolveToken: async () => "tok",
      fetchMessage: async () => {
        if (reason === "read-failed") {
          return { ok: false as const, error: "forbidden", retryAfterSeconds: null };
        }
        if (reason === "absent") return { ok: true as const, messages: [] };
        if (reason === "threw") throw new Error("transport exploded");
        // digest-mismatch: a real message whose participants are not the set the
        // audience was minted from.
        return {
          ok: true as const,
          messages: [
            {
              graphId: "AAMkAGx",
              internetMessageId: `<${MESSAGE}>`,
              subject: "Q3 pricing",
              receivedDateTime: "2026-07-01T10:00:00Z",
              from: { address: "someone-else@contoso.com", name: null },
              toRecipients: [{ address: "other@contoso.com", name: null }],
              ccRecipients: [],
              headersComplete: true,
              bodyUnreadable: false,
              bodyText: "hello",
            },
          ],
        };
      },
      resolve: async () => ({ resolved: new Map(), unresolvedCount: 0 }),
      reconcile: async () => ({ added: 0, revoked: 0 }),
    });
  }

  const REASONS = ["read-failed", "absent", "digest-mismatch", "threw", "unparseable"] as const;

  for (const reason of REASONS) {
    it(`keeps the digest out of the log on the "${reason}" path`, async () => {
      // MUTATION THIS CATCHES: replacing `redactAudienceDigest(audienceId)` with
      // `audienceId` at that branch's log call — the defect a source-text
      // assertion cannot see once someone renames the variable.
      await runPass(reason);
      expect(captured.length).toBeGreaterThan(0);
      for (const entry of captured) {
        expect(allText(entry)).not.toContain(DIGEST);
      }
    });
  }

  it("still logs enough to identify the message — redaction, not omission", async () => {
    // The counterpart claim. Blanking the digest is only acceptable because the
    // mailbox and message id survive; a log line nobody can join to anything is
    // not a safer log line, it is a useless one.
    //
    // MUTATION THIS CATCHES: redacting the whole audience id.
    await runPass("read-failed");
    const withAudience = captured.filter((entry) => "audienceId" in entry.fields);
    expect(withAudience.length).toBeGreaterThan(0);
    for (const entry of withAudience) {
      expect(String(entry.fields.audienceId)).toContain(MAILBOX);
      expect(String(entry.fields.audienceId)).toContain(MESSAGE);
      expect(String(entry.fields.audienceId)).toContain("[digest]");
    }
  });
});
