/**
 * Canonical test set for the semantic-whitelist load policy (#3243 / #3313).
 *
 * Every dialect tool that gates on `gateOnSemanticWhitelist` /
 * `warnIfStructuralOnly` inherits exactly these semantics — plugins assert
 * their wiring, not the policy.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  gateOnSemanticWhitelist,
  warnIfStructuralOnly,
  type SemanticWhitelistSubject,
} from "../semantic-whitelist";
import type { PluginLogger } from "../types";

const SUBJECT: SemanticWhitelistSubject = {
  toolName: "queryExample",
  member: "index",
  structuralExposure: "any explicitly-named, non-system index",
  queryKind: "DSL queries",
  logLabel: "Example DSL",
};

function makeLogger() {
  const calls: { level: string; args: unknown[] }[] = [];
  const record = (level: string) =>
    mock((...args: unknown[]) => {
      calls.push({ level, args });
    });
  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  } as unknown as PluginLogger;
  return { logger, calls };
}

describe("gateOnSemanticWhitelist", () => {
  test("non-empty whitelist → ok gate with the member set", () => {
    const gate = gateOnSemanticWhitelist(SUBJECT, () => ["Orders", "Flights"]);
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.allowed).toEqual(new Set(["Orders", "Flights"]));
      expect(gate.structuralOnly).toBe(false);
    }
  });

  test("legitimately-empty whitelist → ok gate flagged structural-only", () => {
    const gate = gateOnSemanticWhitelist(SUBJECT, () => []);
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.allowed.size).toBe(0);
      expect(gate.structuralOnly).toBe(true);
    }
  });

  test("read() throws → fails CLOSED with the canonical refusal, never structural-only", () => {
    const { logger, calls } = makeLogger();
    const gate = gateOnSemanticWhitelist(
      SUBJECT,
      () => {
        throw new Error("scan failed — whitelist load incomplete");
      },
      logger,
      { index: "products" },
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      // The shape downstream tool tests assert against (/unavailable|refus/i).
      expect(gate.error).toMatch(/unavailable|refus/i);
      // The dialect noun lands in the agent-facing copy.
      expect(gate.error).toContain("index access cannot be verified");
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("error");
    expect(calls[0].args[0]).toMatchObject({
      index: "products",
      error: "scan failed — whitelist load incomplete",
    });
    expect(calls[0].args[1]).toBe("Example DSL refused — semantic layer unavailable (scan failed)");
  });

  test("works without a logger (refusal still returned)", () => {
    const gate = gateOnSemanticWhitelist(SUBJECT, () => {
      throw new Error("nope");
    });
    expect(gate.ok).toBe(false);
  });

  test("non-Error throw is stringified into the log payload", () => {
    const { logger, calls } = makeLogger();
    const gate = gateOnSemanticWhitelist(SUBJECT, () => {
      throw "raw failure"; // exercising the non-Error throw path
    }, logger);
    expect(gate.ok).toBe(false);
    expect(calls[0].args[0]).toMatchObject({ error: "raw failure" });
  });
});

describe("warnIfStructuralOnly", () => {
  test("empty whitelist → one STRUCTURAL-ONLY operator warning with the consequence", () => {
    const { logger, calls } = makeLogger();
    warnIfStructuralOnly(SUBJECT, () => [], logger);
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("warn");
    const msg = calls[0].args[0] as string;
    expect(msg).toContain("queryExample registered with an empty semantic-layer whitelist");
    expect(msg).toContain("STRUCTURAL-ONLY");
    expect(msg).toContain("any explicitly-named, non-system index the credential can read is queryable");
    expect(msg).toContain("per-index allow-list");
  });

  test("structuralExposure defaults from the member noun", () => {
    const { logger, calls } = makeLogger();
    warnIfStructuralOnly(
      { toolName: "querySObjects", member: "object", queryKind: "SOQL queries", logLabel: "SOQL" },
      () => [],
      logger,
    );
    const msg = calls[0].args[0] as string;
    expect(msg).toContain("any explicitly-named object the credential can read is queryable");
    expect(msg).toContain("per-object allow-list");
  });

  test("non-empty whitelist → silent", () => {
    const { logger, calls } = makeLogger();
    warnIfStructuralOnly(SUBJECT, () => ["orders"], logger);
    expect(calls).toHaveLength(0);
  });

  test("read() throws → scan-failure warning naming the fail-closed consequence", () => {
    const { logger, calls } = makeLogger();
    warnIfStructuralOnly(
      SUBJECT,
      () => {
        throw new Error("semantic layer not ready");
      },
      logger,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe("warn");
    const msg = calls[0].args[0] as string;
    expect(msg).toContain("queryExample: semantic-layer scan failed at registration");
    expect(msg).toContain("DSL queries will fail closed");
    expect(msg).toContain("semantic layer not ready");
  });
});
