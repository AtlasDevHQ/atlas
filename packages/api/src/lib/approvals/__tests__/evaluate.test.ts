/**
 * Surface-scoping predicate tests (#2072).
 *
 * Pins the matching semantics for `surfaceMatchesRule`: a rule fires for a
 * request when the rule's surface is `'any'` OR equals the request's
 * surface. Unknown request surface (route forgot to stamp) fails-closed for
 * non-`any` rules so a rule with `surface = 'mcp'` never matches a request
 * whose origin we couldn't identify.
 */

import { describe, it, expect } from "bun:test";
import { surfaceMatchesRule, REQUEST_SURFACES, APPROVAL_RULE_SURFACES } from "../evaluate";
import type { RequestSurface } from "../types";

describe("surfaceMatchesRule (#2072)", () => {
  describe("rule.surface = 'any' — preserves pre-2072 behavior", () => {
    it("matches every defined request surface", () => {
      for (const reqSurface of REQUEST_SURFACES) {
        expect(
          surfaceMatchesRule("any", reqSurface),
          `'any' rule must match request surface "${reqSurface}"`,
        ).toBe(true);
      }
    });

    it("matches when the request surface is unknown (legacy / unstamped routes)", () => {
      // Pre-2072 callers don't stamp surface. An 'any' rule must still
      // fire for them — that's the migration's "non-destructive" promise.
      expect(surfaceMatchesRule("any", undefined)).toBe(true);
    });
  });

  describe("rule.surface = 'mcp' — surface isolation", () => {
    it("fires for an MCP-bound request", () => {
      expect(surfaceMatchesRule("mcp", "mcp")).toBe(true);
    });

    it("does not fire for chat-bound requests with the same query shape", () => {
      // Acceptance criterion from #2072: 'MCP-only rule that fires for MCP
      // queries but not chat queries against the same query shape'.
      expect(surfaceMatchesRule("mcp", "chat")).toBe(false);
    });

    it("does not fire for any other surface", () => {
      const others = REQUEST_SURFACES.filter((s) => s !== "mcp");
      for (const reqSurface of others) {
        expect(
          surfaceMatchesRule("mcp", reqSurface),
          `'mcp' rule must NOT match request surface "${reqSurface}"`,
        ).toBe(false);
      }
    });

    it("does not fire when request surface is unknown (fail-closed)", () => {
      // Non-'any' rules require an identified surface. Unknown surface
      // means the route forgot to stamp; we don't want surface-scoped
      // rules accidentally firing because the binding was missed.
      expect(surfaceMatchesRule("mcp", undefined)).toBe(false);
    });
  });

  describe("rule.surface = 'chat' — symmetric isolation", () => {
    it("fires for a chat-bound request", () => {
      expect(surfaceMatchesRule("chat", "chat")).toBe(true);
    });

    it("does not fire for an MCP-bound request with the same query shape", () => {
      expect(surfaceMatchesRule("chat", "mcp")).toBe(false);
    });

    it("does not fire when request surface is unknown", () => {
      expect(surfaceMatchesRule("chat", undefined)).toBe(false);
    });
  });

  describe("scheduler / slack / teams / webhook surfaces", () => {
    // Defensive enumeration — a future refactor that drops one of the
    // surfaces from the union must surface as a compile error in this
    // exhaustive list, not as a silent runtime gap.
    const cases: { rule: typeof APPROVAL_RULE_SURFACES[number]; req: RequestSurface }[] = [
      { rule: "scheduler", req: "scheduler" },
      { rule: "slack", req: "slack" },
      { rule: "teams", req: "teams" },
      { rule: "webhook", req: "webhook" },
    ];

    for (const { rule, req } of cases) {
      it(`'${rule}' rule fires for '${req}' request`, () => {
        expect(surfaceMatchesRule(rule, req)).toBe(true);
      });

      it(`'${rule}' rule does not fire for 'mcp' request`, () => {
        expect(surfaceMatchesRule(rule, "mcp")).toBe(false);
      });

      it(`'${rule}' rule does not fire for 'chat' request`, () => {
        expect(surfaceMatchesRule(rule, "chat")).toBe(false);
      });
    }
  });

  describe("enum exhaustiveness (catches enum drift)", () => {
    it("APPROVAL_RULE_SURFACES contains 'any' plus every REQUEST_SURFACES value", () => {
      // The rule enum is the request enum + 'any'. If a new request
      // surface lands without a matching rule entry, surface-scoped rules
      // for it cannot be authored — this assertion fails so the schema /
      // migration / type drift is caught at the test layer.
      for (const reqSurface of REQUEST_SURFACES) {
        expect(APPROVAL_RULE_SURFACES).toContain(reqSurface);
      }
      expect(APPROVAL_RULE_SURFACES).toContain("any");
    });
  });
});
