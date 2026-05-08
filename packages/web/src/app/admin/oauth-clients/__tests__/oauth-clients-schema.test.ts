import { describe, expect, test } from "bun:test";
import { ListOAuthClientsResponseSchema } from "@/ui/lib/admin-schemas";

/**
 * Round-trip test for the production parse path in `/admin/oauth-clients`.
 * Guards against silent drift between the API route and the page —
 * page.tsx pipes every `useAdminFetch` response through this schema, so a
 * shape change here is a behavior change for the page.
 */
describe("ListOAuthClientsResponseSchema round-trip", () => {
  const FIXTURE = {
    clients: [
      {
        clientId: "claude-desktop",
        clientName: "Claude Desktop",
        redirectUris: ["http://127.0.0.1:6274/callback"],
        createdAt: "2026-04-18T14:30:00.000Z",
        updatedAt: "2026-04-19T09:15:00.000Z",
        disabled: false,
        type: "public",
        lastUsedAt: "2026-05-01T15:30:00.000Z",
        tokenCount: 3,
        // tokenState (#2066) — required wire field. Active row has at
        // least one outstanding non-expired access or refresh token.
        tokenState: "active" as const,
        // rateLimitPerMinute (#2071) — null means workspace default;
        // non-null is an admin-set override.
        rateLimitPerMinute: 120,
        // workspaceScope (#2073) — required wire field; "single" is
        // the legacy default for clients with no scope row.
        workspaceScope: "single" as const,
        grantedWorkspaceIds: [],
      },
      {
        clientId: "dcr-uuid-abc",
        clientName: null,
        redirectUris: [],
        createdAt: "2026-04-19T10:00:00.000Z",
        updatedAt: null,
        disabled: false,
        type: null,
        lastUsedAt: null,
        tokenCount: 0,
        // Registered but never used — no live tokens yet, but the row
        // is fresh; UI presents the same "registered, awaiting first
        // use" affordance whichever leg of the enum lands here.
        tokenState: "reconnect_required" as const,
        rateLimitPerMinute: null,
        workspaceScope: "single" as const,
        grantedWorkspaceIds: [],
      },
    ],
  };

  test("parses a realistic API response", () => {
    const parsed = ListOAuthClientsResponseSchema.parse(FIXTURE);
    expect(parsed.clients).toHaveLength(2);
    expect(parsed.clients[0]!.clientId).toBe("claude-desktop");
    expect(parsed.clients[0]!.clientName).toBe("Claude Desktop");
    expect(parsed.clients[0]!.redirectUris).toEqual(["http://127.0.0.1:6274/callback"]);
    expect(parsed.clients[0]!.disabled).toBe(false);
    expect(parsed.clients[0]!.tokenCount).toBe(3);
    expect(parsed.clients[1]!.clientName).toBeNull();
    expect(parsed.clients[1]!.lastUsedAt).toBeNull();
  });

  test("clientName is string | null (drift guard)", () => {
    // The page renders `client.clientName ?? client.clientId`. If the schema
    // flipped to `.optional()` (string | undefined), an API response that
    // omits the key entirely would parse cleanly and the page would suddenly
    // receive `undefined` in production. Pin the accepted shape.
    expect(
      ListOAuthClientsResponseSchema.parse({
        clients: [{ ...FIXTURE.clients[0], clientName: null }],
      }).clients[0]!.clientName,
    ).toBeNull();

    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [
          (() => {
            const { clientName: _omit, ...rest } = FIXTURE.clients[0]!;
            return rest;
          })(),
        ],
      }).success,
    ).toBe(false);
  });

  test("lastUsedAt is string | null — null, string, and omission have distinct semantics", () => {
    expect(
      ListOAuthClientsResponseSchema.parse({
        clients: [{ ...FIXTURE.clients[0], lastUsedAt: null }],
      }).clients[0]!.lastUsedAt,
    ).toBeNull();

    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [
          (() => {
            const { lastUsedAt: _omit, ...rest } = FIXTURE.clients[0]!;
            return rest;
          })(),
        ],
      }).success,
    ).toBe(false);
  });

  test("redirectUris is required and an array of valid URIs", () => {
    expect(
      ListOAuthClientsResponseSchema.parse({
        clients: [{ ...FIXTURE.clients[0], redirectUris: [] }],
      }).clients[0]!.redirectUris,
    ).toEqual([]);

    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [{ ...FIXTURE.clients[0], redirectUris: "not-an-array" }],
      }).success,
    ).toBe(false);

    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [
          (() => {
            const { redirectUris: _omit, ...rest } = FIXTURE.clients[0]!;
            return rest;
          })(),
        ],
      }).success,
    ).toBe(false);

    // OAuth 2.1 / RFC 7591 require absolute URIs. A non-URI string slipping
    // through the API would render as a broken row in the page; reject at
    // parse time.
    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [{ ...FIXTURE.clients[0], redirectUris: ["not-a-url"] }],
      }).success,
    ).toBe(false);
  });

  test("disabled is required boolean (drift guard)", () => {
    // The page renders `client.disabled` as a load-bearing branch (badge
    // text + status kind). A drift to `boolean | undefined` would silently
    // resolve every client to "not disabled" via Boolean(undefined) → false.
    expect(
      ListOAuthClientsResponseSchema.parse({
        clients: [{ ...FIXTURE.clients[0], disabled: true }],
      }).clients[0]!.disabled,
    ).toBe(true);

    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [{ ...FIXTURE.clients[0], disabled: null }],
      }).success,
    ).toBe(false);

    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [
          (() => {
            const { disabled: _omit, ...rest } = FIXTURE.clients[0]!;
            return rest;
          })(),
        ],
      }).success,
    ).toBe(false);
  });

  test("type is string | null — null, string, and omission have distinct semantics", () => {
    expect(
      ListOAuthClientsResponseSchema.parse({
        clients: [{ ...FIXTURE.clients[0], type: "public" }],
      }).clients[0]!.type,
    ).toBe("public");

    expect(
      ListOAuthClientsResponseSchema.parse({
        clients: [{ ...FIXTURE.clients[0], type: null }],
      }).clients[0]!.type,
    ).toBeNull();

    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [
          (() => {
            const { type: _omit, ...rest } = FIXTURE.clients[0]!;
            return rest;
          })(),
        ],
      }).success,
    ).toBe(false);
  });

  test("clientId rejects empty string", () => {
    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [{ ...FIXTURE.clients[0], clientId: "" }],
      }).success,
    ).toBe(false);
  });

  test("tokenCount is a non-negative integer — strings, NaN, negatives, fractions all rejected", () => {
    // The route hands back `parseInt(r.tokenCount, 10)`. A future regression
    // that forgets the parse and emits a stringly-typed COUNT(*) result
    // would silently render "[object Object]" or NaN — pin the contract.
    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [{ ...FIXTURE.clients[0], tokenCount: "3" }],
      }).success,
    ).toBe(false);

    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [{ ...FIXTURE.clients[0], tokenCount: Number.NaN }],
      }).success,
    ).toBe(false);

    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [{ ...FIXTURE.clients[0], tokenCount: -1 }],
      }).success,
    ).toBe(false);

    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [{ ...FIXTURE.clients[0], tokenCount: 1.5 }],
      }).success,
    ).toBe(false);
  });

  test("rejects when `clients` is missing", () => {
    expect(ListOAuthClientsResponseSchema.safeParse({}).success).toBe(false);
  });
});
