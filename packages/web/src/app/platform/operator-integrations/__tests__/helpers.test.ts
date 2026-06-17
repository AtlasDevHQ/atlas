import { describe, expect, test } from "bun:test";
import {
  buildCredentialPayload,
  destructiveRotations,
  hasAnyEdit,
} from "../helpers";

// Mirrors the Slack field set the page renders. `destructiveRotation` is true
// only on the encryption key (the rotation that forces re-authorization).
const FIELDS = [
  { envVar: "SLACK_CLIENT_ID", destructiveRotation: false },
  { envVar: "SLACK_CLIENT_SECRET", destructiveRotation: false },
  { envVar: "SLACK_SIGNING_SECRET", destructiveRotation: false },
  { envVar: "SLACK_ENCRYPTION_KEY", destructiveRotation: true },
] as const;

describe("buildCredentialPayload — blank=preserve, no-trim", () => {
  test("includes only fields with non-whitespace drafts", () => {
    const payload = buildCredentialPayload(FIELDS, {
      SLACK_CLIENT_ID: "A123",
      SLACK_SIGNING_SECRET: "new-sign",
    });
    expect(payload).toEqual({ SLACK_CLIENT_ID: "A123", SLACK_SIGNING_SECRET: "new-sign" });
  });

  test("omits blank and whitespace-only drafts (preserve on the server)", () => {
    const payload = buildCredentialPayload(FIELDS, {
      SLACK_CLIENT_ID: "",
      SLACK_CLIENT_SECRET: "   ",
      SLACK_SIGNING_SECRET: "\t\n",
      SLACK_ENCRYPTION_KEY: "real",
    });
    expect(payload).toEqual({ SLACK_ENCRYPTION_KEY: "real" });
  });

  test("sends the UNTRIMMED value so edge whitespace in a real secret is preserved", () => {
    const payload = buildCredentialPayload(FIELDS, {
      SLACK_CLIENT_SECRET: "  has-edges  ",
    });
    expect(payload).toEqual({ SLACK_CLIENT_SECRET: "  has-edges  " });
  });

  test("empty draft yields an empty payload", () => {
    expect(buildCredentialPayload(FIELDS, {})).toEqual({});
  });
});

describe("destructiveRotations — confirm-dialog gate", () => {
  test("returns the destructive field when its draft is non-empty", () => {
    const edits = destructiveRotations(FIELDS, { SLACK_ENCRYPTION_KEY: "rotate" });
    expect(edits.map((f) => f.envVar)).toEqual(["SLACK_ENCRYPTION_KEY"]);
  });

  test("ignores a destructive field left blank or whitespace-only", () => {
    expect(destructiveRotations(FIELDS, { SLACK_ENCRYPTION_KEY: "   " })).toEqual([]);
  });

  test("editing only non-destructive fields does not trigger the gate", () => {
    expect(destructiveRotations(FIELDS, { SLACK_SIGNING_SECRET: "new-sign" })).toEqual([]);
  });
});

describe("hasAnyEdit — Save-button gate", () => {
  test("true when any field has a non-empty draft", () => {
    expect(hasAnyEdit(FIELDS, { SLACK_CLIENT_ID: "A1" })).toBe(true);
  });

  test("false when all drafts are blank or whitespace-only", () => {
    expect(hasAnyEdit(FIELDS, { SLACK_CLIENT_ID: "", SLACK_CLIENT_SECRET: "  " })).toBe(false);
  });

  test("false for an empty draft", () => {
    expect(hasAnyEdit(FIELDS, {})).toBe(false);
  });
});
