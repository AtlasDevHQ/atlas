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

  test("redirectUris is required and an array of strings", () => {
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
  });

  test("tokenCount is a number — string-encoded counts are rejected", () => {
    // The route hands back `parseInt(r.tokenCount, 10)`. A future regression
    // that forgets the parse and emits a stringly-typed COUNT(*) result
    // would silently render "[object Object]" or NaN — pin the contract.
    expect(
      ListOAuthClientsResponseSchema.safeParse({
        clients: [{ ...FIXTURE.clients[0], tokenCount: "3" }],
      }).success,
    ).toBe(false);
  });

  test("rejects when `clients` is missing", () => {
    expect(ListOAuthClientsResponseSchema.safeParse({}).success).toBe(false);
  });
});
