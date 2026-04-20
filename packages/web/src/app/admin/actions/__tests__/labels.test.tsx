import { describe, expect, test } from "bun:test";
import { Zap, Database, Globe, FilePenLine, Terminal } from "lucide-react";
import { actionTypeIcon, actionTypeLabel } from "../labels";

/**
 * `actionTypeLabel` / `actionTypeIcon` both call `.toLowerCase()` on the
 * input before looking up the registry. Dev fixtures happen to be all-
 * lowercase so a manual click-through would never catch a regression that
 * dropped the lowercasing — every unknown-cased input would silently fall
 * through to the Zap/raw-string fallback and the page would still render.
 * Pin the case-insensitivity contract here so that class of bug surfaces.
 */
describe("actionTypeLabel", () => {
  test("known lowercase types map to their labels", () => {
    expect(actionTypeLabel("sql_write")).toBe("SQL Write");
    expect(actionTypeLabel("sql")).toBe("SQL");
    expect(actionTypeLabel("api_call")).toBe("API Call");
    expect(actionTypeLabel("api")).toBe("API");
    expect(actionTypeLabel("file_write")).toBe("File Write");
    expect(actionTypeLabel("file")).toBe("File");
    expect(actionTypeLabel("shell")).toBe("Shell");
    expect(actionTypeLabel("command")).toBe("Command");
  });

  test("mixed-case input still maps (load-bearing .toLowerCase())", () => {
    expect(actionTypeLabel("SQL_Write")).toBe("SQL Write");
    expect(actionTypeLabel("SQL_WRITE")).toBe("SQL Write");
    expect(actionTypeLabel("Api_Call")).toBe("API Call");
    expect(actionTypeLabel("FILE")).toBe("File");
  });

  test("unknown type returns the raw input verbatim", () => {
    // The fallback returns the raw `type` argument (not lowercased) so the
    // caller still sees what the agent actually sent.
    expect(actionTypeLabel("webhook_post")).toBe("webhook_post");
    expect(actionTypeLabel("CustomTool")).toBe("CustomTool");
    expect(actionTypeLabel("")).toBe("");
  });
});

describe("actionTypeIcon", () => {
  test("known lowercase types map to their icon", () => {
    expect(actionTypeIcon("sql_write")).toBe(Database);
    expect(actionTypeIcon("sql")).toBe(Database);
    expect(actionTypeIcon("api_call")).toBe(Globe);
    expect(actionTypeIcon("api")).toBe(Globe);
    expect(actionTypeIcon("file_write")).toBe(FilePenLine);
    expect(actionTypeIcon("file")).toBe(FilePenLine);
    expect(actionTypeIcon("shell")).toBe(Terminal);
    expect(actionTypeIcon("command")).toBe(Terminal);
  });

  test("mixed-case input still maps to the right icon", () => {
    expect(actionTypeIcon("SQL_Write")).toBe(Database);
    expect(actionTypeIcon("API_CALL")).toBe(Globe);
    expect(actionTypeIcon("File_Write")).toBe(FilePenLine);
    expect(actionTypeIcon("SHELL")).toBe(Terminal);
  });

  test("unknown type returns Zap (reference equality)", () => {
    // Asserting reference equality (not just truthy) locks the fallback —
    // a regression that returned a different LucideIcon would break the
    // admin UX's consistent "unknown tool" affordance.
    expect(actionTypeIcon("webhook_post")).toBe(Zap);
    expect(actionTypeIcon("")).toBe(Zap);
  });
});
