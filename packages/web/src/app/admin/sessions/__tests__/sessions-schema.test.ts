import { describe, expect, test } from "bun:test";
import { SessionsListSchema } from "@/ui/lib/admin-schemas";

/**
 * Round-trip test for the production parse path in `/admin/sessions`.
 * Guards against silent API drift — page.tsx feeds every `useAdminFetch`
 * response through this schema, so a shape change here is a behavior
 * change for the page.
 */
describe("SessionsListSchema round-trip", () => {
  const FIXTURE = {
    sessions: [
      {
        id: "sess_abc123",
        userId: "user_admin",
        userEmail: "admin@useatlas.dev",
        createdAt: "2026-04-18T14:30:00.000Z",
        updatedAt: "2026-04-19T09:15:00.000Z",
        expiresAt: "2026-04-25T14:30:00.000Z",
        ipAddress: "10.0.0.1",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      },
      {
        id: "sess_def456",
        userId: "user_bob",
        userEmail: null,
        createdAt: "2026-04-19T10:00:00.000Z",
        updatedAt: "2026-04-19T10:00:00.000Z",
        expiresAt: "2026-04-26T10:00:00.000Z",
        ipAddress: null,
        userAgent: null,
      },
    ],
    total: 2,
  };

  test("parses a realistic API response", () => {
    const parsed = SessionsListSchema.parse(FIXTURE);
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.total).toBe(2);
    expect(parsed.sessions[0]!.id).toBe("sess_abc123");
    expect(parsed.sessions[0]!.userId).toBe("user_admin");
    expect(parsed.sessions[0]!.userEmail).toBe("admin@useatlas.dev");
  });

  test("ipAddress is string | null (drift guard)", () => {
    // The admin page renders `row.getValue<string | null>("ipAddress") ?? "—"`.
    // If the schema flipped to `.optional()` (i.e. string | undefined), the
    // API could omit the key entirely without a parse error and the page
    // column would suddenly receive `undefined` in a production payload.
    // These two assertions pin the accepted shape.
    expect(
      SessionsListSchema.parse({
        sessions: [{ ...FIXTURE.sessions[0], ipAddress: null }],
        total: 1,
      }).sessions[0]!.ipAddress,
    ).toBeNull();

    expect(
      SessionsListSchema.safeParse({
        sessions: [
          {
            ...FIXTURE.sessions[0],
            ipAddress: undefined, // key present but undefined — shape drift
          },
        ],
        total: 1,
      }).success,
    ).toBe(false);

    expect(
      SessionsListSchema.safeParse({
        sessions: [
          (() => {
            // Key omitted entirely — also shape drift.
            const { ipAddress: _omit, ...rest } = FIXTURE.sessions[0]!;
            return rest;
          })(),
        ],
        total: 1,
      }).success,
    ).toBe(false);
  });

  test("userAgent is string | null — null, string, and omission behave the same as ipAddress", () => {
    expect(
      SessionsListSchema.parse({
        sessions: [{ ...FIXTURE.sessions[0], userAgent: "curl/8.0" }],
        total: 1,
      }).sessions[0]!.userAgent,
    ).toBe("curl/8.0");

    expect(
      SessionsListSchema.parse({
        sessions: [{ ...FIXTURE.sessions[0], userAgent: null }],
        total: 1,
      }).sessions[0]!.userAgent,
    ).toBeNull();

    expect(
      SessionsListSchema.safeParse({
        sessions: [
          (() => {
            const { userAgent: _omit, ...rest } = FIXTURE.sessions[0]!;
            return rest;
          })(),
        ],
        total: 1,
      }).success,
    ).toBe(false);
  });

  test("timestamps are required ISO strings", () => {
    const parsed = SessionsListSchema.parse(FIXTURE);
    // The schema keeps them as opaque strings (no z.string().datetime())
    // because Postgres emits ISO already and the page only passes them
    // to RelativeTimestamp, which does its own parsing. Pin both the
    // presence and the passthrough so a future add of `.datetime()` is
    // a deliberate tightening, not an accident.
    expect(parsed.sessions[0]!.createdAt).toBe("2026-04-18T14:30:00.000Z");
    expect(parsed.sessions[0]!.updatedAt).toBe("2026-04-19T09:15:00.000Z");
    expect(parsed.sessions[0]!.expiresAt).toBe("2026-04-25T14:30:00.000Z");

    // Missing any of the three timestamps is a parse error.
    for (const field of ["createdAt", "updatedAt", "expiresAt"] as const) {
      const { [field]: _omit, ...rest } = FIXTURE.sessions[0]!;
      const res = SessionsListSchema.safeParse({
        sessions: [rest],
        total: 1,
      });
      expect(res.success).toBe(false);
    }
  });

  test("pagination: offset/limit shape — `total: number`, no cursor field", () => {
    // The admin/sessions endpoint uses offset/limit pagination and returns
    // `total`. There is deliberately no `nextCursor` in the client schema;
    // if the API ever adds one, a parse of a payload with that extra field
    // must still succeed (z.object() strips unknown keys by default) while
    // missing `total` must fail. Both halves of that contract are asserted.
    const withExtra = SessionsListSchema.parse({ ...FIXTURE, nextCursor: "abc" });
    expect(withExtra.total).toBe(2);
    expect((withExtra as unknown as { nextCursor?: unknown }).nextCursor).toBeUndefined();

    const { total: _omit, ...noTotal } = FIXTURE;
    expect(SessionsListSchema.safeParse(noTotal).success).toBe(false);
  });

  test("rejects when `sessions` is missing", () => {
    const { sessions: _omit, ...noSessions } = FIXTURE;
    expect(SessionsListSchema.safeParse(noSessions).success).toBe(false);
  });
});
