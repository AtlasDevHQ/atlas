import { describe, expect, test } from "bun:test";
import { Crown, Shield, ShieldCheck } from "lucide-react";
import { roleBadge } from "../roles";

describe("roleBadge", () => {
  test("owner resolves to Crown + purple classes", () => {
    const { Icon, className } = roleBadge("owner");
    expect(Icon).toBe(Crown);
    expect(className).toContain("text-purple-700");
  });

  test("admin resolves to ShieldCheck + red classes", () => {
    const { Icon, className } = roleBadge("admin");
    expect(Icon).toBe(ShieldCheck);
    expect(className).toContain("text-red-700");
  });

  test("member resolves to Shield + primary classes", () => {
    const { Icon, className } = roleBadge("member");
    expect(Icon).toBe(Shield);
    expect(className).toContain("text-primary");
  });

  test("unknown roles fall back to the neutral member variant", () => {
    // If the server returns a role the UI doesn't know about (legacy
    // "guest", future "billing-admin", DB drift), the sheet must still
    // render a readable badge instead of an empty className. The member
    // variant is the safe default — it's the lowest-privilege role and
    // matches the rendering an operator would expect for "unknown".
    const unknown = roleBadge("billing-admin");
    expect(unknown.Icon).toBe(Shield);
    expect(unknown.className).toContain("text-primary");

    const empty = roleBadge("");
    expect(empty.Icon).toBe(Shield);
    expect(empty.className).toContain("text-primary");
  });
});
