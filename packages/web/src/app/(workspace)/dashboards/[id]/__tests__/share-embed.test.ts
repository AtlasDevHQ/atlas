import { describe, expect, test } from "bun:test";
import { buildEmbedSnippet } from "../share-embed";

describe("buildEmbedSnippet (#4564)", () => {
  test("targets the share token's /embed sub-route", () => {
    const code = buildEmbedSnippet("https://app.example.com/shared/dashboard/tok_live");
    expect(code).toContain('src="https://app.example.com/shared/dashboard/tok_live/embed"');
    expect(code).toStartWith("<iframe");
    expect(code).toEndWith("></iframe>");
  });

  test("escapes double quotes so a token cannot break out of the src attribute", () => {
    // A stray quote in the URL must not close the attribute early — pin the
    // security invariant the comment claims.
    const code = buildEmbedSnippet('https://app.example.com/shared/dashboard/a"b');
    expect(code).toContain("&quot;");
    // Exactly two real `"` delimiters remain (the ones around src) — the injected
    // one is now `&quot;`, so it can't terminate the attribute.
    expect(code).not.toContain('a"b');
    expect(code).toContain('a&quot;b/embed');
  });

  test("omits ?theme= by default so the embed follows the visitor's system (#4686)", () => {
    const code = buildEmbedSnippet("https://app.example.com/shared/dashboard/tok_live");
    expect(code).toContain('src="https://app.example.com/shared/dashboard/tok_live/embed"');
    expect(code).not.toContain("?theme=");
  });

  test("appends the forced ?theme= param when a light/dark appearance is chosen (#4686)", () => {
    const dark = buildEmbedSnippet("https://app.example.com/shared/dashboard/tok_live", "dark");
    expect(dark).toContain('src="https://app.example.com/shared/dashboard/tok_live/embed?theme=dark"');
    const light = buildEmbedSnippet("https://app.example.com/shared/dashboard/tok_live", "light");
    expect(light).toContain("/embed?theme=light");
  });
});
