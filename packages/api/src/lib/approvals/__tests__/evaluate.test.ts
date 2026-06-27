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
import type { ModelMessage } from "ai";
import {
  originMatchesRule,
  REQUEST_ORIGINS,
  APPROVAL_RULE_ORIGINS,
  findApprovalParkSignal,
  applyApprovalDecision,
} from "../evaluate";
import type { RequestOrigin } from "../types";

/** A transcript whose last tool result is the executeSQL needs-approval marker. */
function parkedTranscript(approvalRequestId: string, toolCallId = "call-1"): ModelMessage[] {
  return [
    { role: "user", content: "show me revenue" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId, toolName: "executeSQL", input: { sql: "SELECT revenue FROM accounts", explanation: "rev" } },
      ],
    } as unknown as ModelMessage,
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "executeSQL",
          output: {
            type: "json",
            value: {
              success: false,
              approval_required: true,
              approval_request_id: approvalRequestId,
              matched_rules: ["PII tables"],
              message: "This query requires approval.",
              executionMs: 0,
            },
          },
        },
      ],
    } as unknown as ModelMessage,
  ];
}

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
      // #4043 / ADR-0025 — the atlas-login device flow is audited origin=cli;
      // an admin can scope an approval rule to the CLI transport.
      { rule: "cli", req: "cli" },
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

describe("findApprovalParkSignal (#3748 approval-park detection)", () => {
  it("finds the needs-approval tool result and returns its queue ref + tool-call id", () => {
    const signal = findApprovalParkSignal(parkedTranscript("req-42", "call-7"));
    expect(signal).toEqual({ approvalRequestId: "req-42", toolCallId: "call-7" });
  });

  it("returns undefined for a transcript with no needs-approval result (normal turn)", () => {
    const transcript: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "executeSQL",
            output: { type: "json", value: { success: true, columns: ["id"], rows: [{ id: 1 }] } },
          },
        ],
      } as unknown as ModelMessage,
    ];
    expect(findApprovalParkSignal(transcript)).toBeUndefined();
  });

  it("ignores a result missing the request id (a malformed marker is not a park)", () => {
    const transcript: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "executeSQL",
            output: { type: "json", value: { approval_required: true } },
          },
        ],
      } as unknown as ModelMessage,
    ];
    expect(findApprovalParkSignal(transcript)).toBeUndefined();
  });

  it("parses a stringified (text) tool output as a fallback encoding", () => {
    const transcript: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "executeSQL",
            output: { type: "text", value: JSON.stringify({ approval_required: true, approval_request_id: "req-text" }) },
          },
        ],
      } as unknown as ModelMessage,
    ];
    expect(findApprovalParkSignal(transcript)?.approvalRequestId).toBe("req-text");
  });

  it("returns the LAST needs-approval result when more than one is present", () => {
    const transcript = [...parkedTranscript("req-first", "c1"), ...parkedTranscript("req-second", "c2")];
    expect(findApprovalParkSignal(transcript)?.approvalRequestId).toBe("req-second");
  });

  it("returns undefined for an empty / undefined transcript", () => {
    expect(findApprovalParkSignal([])).toBeUndefined();
    expect(findApprovalParkSignal(undefined)).toBeUndefined();
  });
});

describe("applyApprovalDecision (#3748 transcript rewrite)", () => {
  it("approve replaces the needs-approval result with an approved, re-run-the-query marker", () => {
    const before = parkedTranscript("req-42");
    const { transcript: after, changed } = applyApprovalDecision(before, "req-42", "approve", {
      reviewerLabel: "admin@x.com",
    });

    // A matching marker was found and rewritten.
    expect(changed).toBe(true);
    // The rewritten transcript is no longer a park (detection now finds nothing).
    expect(findApprovalParkSignal(after)).toBeUndefined();

    const toolMsg = after.find((m) => m.role === "tool")!;
    const part = (toolMsg.content as unknown[])[0] as { output: { value: Record<string, unknown> } };
    expect(part.output.value.approval_resolved).toBe("approved");
    expect(part.output.value.approval_required).toBe(false);
    expect(String(part.output.value.message)).toContain("APPROVED");
    expect(String(part.output.value.message)).toContain("admin@x.com");
    expect(String(part.output.value.message)).toContain("Re-run");
  });

  it("deny replaces it with a denial marker that tells the agent not to retry", () => {
    const { transcript: after, changed } = applyApprovalDecision(parkedTranscript("req-42"), "req-42", "deny", {
      comment: "prod is frozen",
    });
    expect(changed).toBe(true);
    const toolMsg = after.find((m) => m.role === "tool")!;
    const part = (toolMsg.content as unknown[])[0] as { output: { value: Record<string, unknown> } };
    expect(part.output.value.approval_resolved).toBe("denied");
    expect(String(part.output.value.message)).toContain("DENIED");
    expect(String(part.output.value.message)).toContain("prod is frozen");
    expect(String(part.output.value.message)).toContain("Do not retry");
  });

  it("does not mutate the original transcript", () => {
    const before = parkedTranscript("req-42");
    const snapshot = JSON.parse(JSON.stringify(before));
    applyApprovalDecision(before, "req-42", "approve");
    expect(before).toEqual(snapshot);
  });

  it("reports changed=false and is a no-op when the request id does not match any needs-approval result", () => {
    const before = parkedTranscript("req-42");
    const { transcript: after, changed } = applyApprovalDecision(before, "req-other", "approve");
    // No matching marker → the resolver uses this to fail closed (leave parked).
    expect(changed).toBe(false);
    // Unchanged → still a park on the original id.
    expect(findApprovalParkSignal(after)?.approvalRequestId).toBe("req-42");
  });
});
