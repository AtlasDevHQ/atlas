import { test, expect, spyOn } from "bun:test";
import { githubEditPath } from "@/lib/mdx-links";

// Unit coverage for the pure "Edit on GitHub" / last-updated path derivation.
// This is the function that fixed the shared-page edit link (it replaced the
// hardcoded `content/docs/${page.path}`, which pointed shared pages at a
// non-existent content/docs twin — spike #4258 caveat #1). Locking its three
// branches keeps a refactor from silently 404-ing every shared page's edit link.

test("prefixes apps/docs/ onto a Fumadocs relative absolutePath", () => {
  expect(githubEditPath("content/docs/guides/slack.mdx")).toBe(
    "apps/docs/content/docs/guides/slack.mdx",
  );
});

test("a shared page resolves to the one real content/shared file", () => {
  expect(githubEditPath("content/shared/single-source-example.mdx")).toBe(
    "apps/docs/content/shared/single-source-example.mdx",
  );
});

test("slices from the marker when given an absolute path containing apps/docs/", () => {
  expect(
    githubEditPath("/home/x/atlas/apps/docs/content/self-hosted/index.mdx"),
  ).toBe("apps/docs/content/self-hosted/index.mdx");
});

test("degrades to apps/docs/ and warns for a missing absolutePath", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(githubEditPath(undefined)).toBe("apps/docs/");
    // The anomaly must not be silent (Atlas: never silently swallow).
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});
