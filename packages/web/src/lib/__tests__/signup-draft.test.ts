/**
 * Coverage for the signup draft (ADR-0024 §4, #3972).
 *
 * The draft carries the collected email (+ optional invitationId) across the
 * region step's hard reload via sessionStorage. These tests pin the round-trip,
 * the invitation passthrough, and the defensive reads (missing / malformed /
 * email-less values resolve to null rather than throwing).
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { saveSignupDraft, readSignupDraft, clearSignupDraft } from "../signup-draft";

const KEY = "atlas:signup:draft";

beforeEach(() => {
  sessionStorage.clear();
});

describe("signup-draft", () => {
  test("round-trips the email", () => {
    saveSignupDraft({ email: "jane@example.com" });
    expect(readSignupDraft()).toEqual({ email: "jane@example.com", invitationId: undefined });
  });

  test("carries the invitationId when present", () => {
    saveSignupDraft({ email: "teammate@acme.com", invitationId: "inv-9" });
    expect(readSignupDraft()).toEqual({ email: "teammate@acme.com", invitationId: "inv-9" });
  });

  test("returns null when no draft is stored", () => {
    expect(readSignupDraft()).toBeNull();
  });

  test("ignores a malformed (unparseable) draft instead of throwing", () => {
    sessionStorage.setItem(KEY, "{not json");
    expect(readSignupDraft()).toBeNull();
  });

  test("ignores a draft with no email (an incomplete write)", () => {
    sessionStorage.setItem(KEY, JSON.stringify({ invitationId: "inv-9" }));
    expect(readSignupDraft()).toBeNull();
  });

  test("clearSignupDraft removes the stored draft", () => {
    saveSignupDraft({ email: "jane@example.com" });
    clearSignupDraft();
    expect(readSignupDraft()).toBeNull();
  });
});
