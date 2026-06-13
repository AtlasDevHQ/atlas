/**
 * Origin-scoping predicate tests (#2072).
 *
 * Pins the matching semantics for `originMatchesRule`: a rule fires for a
 * request when the rule's origin is `'any'` OR equals the request's
 * origin. Unknown request origin (route forgot to stamp) fails-closed for
 * non-`any` rules so a rule with `origin = 'mcp'` never matches a request
 * whose origin we couldn't identify.
 */

import { describe, it, expect } from "bun:test";
import { originMatchesRule, REQUEST_ORIGINS, APPROVAL_RULE_ORIGINS } from "../evaluate";
import type { RequestOrigin } from "../types";

describe("originMatchesRule (#2072)", () => {
  describe("rule.origin = 'any' — preserves pre-2072 behavior", () => {
    it("matches every defined request origin", () => {
      for (const reqOrigin of REQUEST_ORIGINS) {
        expect(
          originMatchesRule("any", reqOrigin),
          `'any' rule must match request origin "${reqOrigin}"`,
        ).toBe(true);
      }
    });

    it("matches when the request origin is unknown (legacy / unstamped routes)", () => {
      // Pre-2072 callers don't stamp origin. An 'any' rule must still
      // fire for them — that's the migration's "non-destructive" promise.
      expect(originMatchesRule("any", undefined)).toBe(true);
    });
  });

  describe("rule.origin = 'mcp' — origin isolation", () => {
    it("fires for an MCP-bound request", () => {
      expect(originMatchesRule("mcp", "mcp")).toBe(true);
    });

    it("does not fire for chat-bound requests with the same query shape", () => {
      // Acceptance criterion from #2072: 'MCP-only rule that fires for MCP
      // queries but not chat queries against the same query shape'.
      expect(originMatchesRule("mcp", "chat")).toBe(false);
    });

    it("does not fire for any other origin", () => {
      const others = REQUEST_ORIGINS.filter((s) => s !== "mcp");
      for (const reqOrigin of others) {
        expect(
          originMatchesRule("mcp", reqOrigin),
          `'mcp' rule must NOT match request origin "${reqOrigin}"`,
        ).toBe(false);
      }
    });

    it("does not fire when request origin is unknown (fail-closed)", () => {
      // Non-'any' rules require an identified origin. Unknown origin
      // means the route forgot to stamp; we don't want origin-scoped
      // rules accidentally firing because the binding was missed.
      expect(originMatchesRule("mcp", undefined)).toBe(false);
    });
  });

  describe("rule.origin = 'chat' — symmetric isolation", () => {
    it("fires for a chat-bound request", () => {
      expect(originMatchesRule("chat", "chat")).toBe(true);
    });

    it("does not fire for an MCP-bound request with the same query shape", () => {
      expect(originMatchesRule("chat", "mcp")).toBe(false);
    });

    it("does not fire when request origin is unknown", () => {
      expect(originMatchesRule("chat", undefined)).toBe(false);
    });
  });

  describe("scheduler / slack / teams / webhook surfaces", () => {
    // Defensive enumeration — a future refactor that drops one of the
    // surfaces from the union must surface as a compile error in this
    // exhaustive list, not as a silent runtime gap.
    const cases: { rule: typeof APPROVAL_RULE_ORIGINS[number]; req: RequestOrigin }[] = [
      { rule: "scheduler", req: "scheduler" },
      { rule: "slack", req: "slack" },
      { rule: "teams", req: "teams" },
      { rule: "webhook", req: "webhook" },
    ];

    for (const { rule, req } of cases) {
      it(`'${rule}' rule fires for '${req}' request`, () => {
        expect(originMatchesRule(rule, req)).toBe(true);
      });

      it(`'${rule}' rule does not fire for 'mcp' request`, () => {
        expect(originMatchesRule(rule, "mcp")).toBe(false);
      });

      it(`'${rule}' rule does not fire for 'chat' request`, () => {
        expect(originMatchesRule(rule, "chat")).toBe(false);
      });
    }
  });

  describe("enum exhaustiveness (catches enum drift)", () => {
    it("APPROVAL_RULE_ORIGINS contains 'any' plus every REQUEST_ORIGINS value", () => {
      // The rule enum is the request enum + 'any'. If a new request
      // origin lands without a matching rule entry, origin-scoped rules
      // for it cannot be authored — this assertion fails so the schema /
      // migration / type drift is caught at the test layer.
      for (const reqOrigin of REQUEST_ORIGINS) {
        expect(APPROVAL_RULE_ORIGINS).toContain(reqOrigin);
      }
      expect(APPROVAL_RULE_ORIGINS).toContain("any");
    });
  });
});
