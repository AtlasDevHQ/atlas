/**
 * The retired validateProposal tool must be absent from the expert registry
 * (#4513 AC5). Validation is a seam folded into proposeAmendment, not a
 * standalone tool — the registry must not offer it to the model.
 */

import { describe, it, expect } from "bun:test";
import { buildExpertRegistry } from "../expert-registry";

describe("buildExpertRegistry tool surface (#4513)", () => {
  const registry = buildExpertRegistry();
  const names = [...registry.entries()].map(([name]) => name);

  it("still offers proposeAmendment and the standard evidence tools", () => {
    for (const name of ["explore", "executeSQL", "profileTable", "checkDataDistribution", "searchAuditLog", "proposeAmendment"]) {
      expect(registry.get(name)).toBeDefined();
    }
  });

  it("no longer registers the retired validateProposal tool", () => {
    expect(registry.get("validateProposal")).toBeUndefined();
    expect(names).not.toContain("validateProposal");
  });

  it("exposes exactly six tools", () => {
    expect(names).toHaveLength(6);
  });
});
