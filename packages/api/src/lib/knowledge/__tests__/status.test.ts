/**
 * Pins the fail-closed posture of `narrowKnowledgeStatus`: the fallback arm is
 * unreachable through the CHECK-constrained DB today, but its whole purpose is
 * the day that CHECK is widened without updating the tuple — an unrecognized
 * value must land on the caller's under-privileged fallback, never flow
 * through as trusted `published` content.
 */

import { describe, expect, it } from "bun:test";
import {
  KNOWLEDGE_DOCUMENT_STATUSES,
  narrowKnowledgeStatus,
} from "../status";

describe("narrowKnowledgeStatus", () => {
  it("passes every vocabulary value through unchanged", () => {
    for (const status of KNOWLEDGE_DOCUMENT_STATUSES) {
      expect(narrowKnowledgeStatus(status, "draft")).toBe(status);
    }
  });

  it("maps anything outside the vocabulary to the caller's fallback", () => {
    expect(narrowKnowledgeStatus("pending_review", "draft")).toBe("draft");
    expect(narrowKnowledgeStatus("", "archived")).toBe("archived");
    expect(narrowKnowledgeStatus(null, "draft")).toBe("draft");
    expect(narrowKnowledgeStatus(42, "draft")).toBe("draft");
  });
});
