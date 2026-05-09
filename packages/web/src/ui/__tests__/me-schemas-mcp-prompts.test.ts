import { describe, expect, test, spyOn } from "bun:test";
import { McpCanonicalGateSchema, McpPromptsResponseSchema } from "@/ui/lib/me-schemas";
import { McpPromptsResponseSchema as RouteResponseSchema } from "@useatlas/schemas/mcp-prompts";

describe("McpCanonicalGateSchema (web tolerant variant)", () => {
  test("coerces a forward-compat reason to null and warns", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parsed = McpCanonicalGateSchema.parse({
        exposed: false,
        toggle: "auto",
        reason: "future-signal",
      });
      expect(parsed.reason).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("[mcp-prompts]");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("known-good reason values still parse strictly without firing the warn", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parsed = McpCanonicalGateSchema.parse({
        exposed: false,
        toggle: "auto",
        reason: "no-demo-signal",
      });
      expect(parsed.reason).toBe("no-demo-signal");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("Wire contract — route strict vs web tolerant", () => {
  const forwardCompatPayload = {
    prompts: [],
    canonicalGate: {
      exposed: false,
      toggle: "auto" as const,
      reason: "future-signal",
    },
  };

  test("the route's strict schema rejects a forward-compat reason", () => {
    expect(() => RouteResponseSchema.parse(forwardCompatPayload)).toThrow();
  });

  test("the web's tolerant schema accepts it and degrades reason to null", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parsed = McpPromptsResponseSchema.parse(forwardCompatPayload);
      expect(parsed.canonicalGate.reason).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
