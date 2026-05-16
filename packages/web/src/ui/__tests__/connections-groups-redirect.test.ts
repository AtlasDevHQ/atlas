import { describe, expect, mock, test } from "bun:test";

mock.module("next/navigation", () => ({
  redirect: (url: string) => {
    // Mirror Next.js semantics — `redirect` throws to interrupt
    // rendering. We throw a tagged error the test asserts on.
    const err = new Error("NEXT_REDIRECT") as Error & { url: string };
    err.url = url;
    throw err;
  },
}));

// Imported after the mock so the page picks up the stubbed `redirect`.
const ConnectionGroupsRedirect = (
  await import("../../app/admin/connections/groups/page")
).default;

describe("/admin/connections/groups", () => {
  test("server-side-redirects to the embedded environments view", () => {
    let captured: string | undefined;
    try {
      ConnectionGroupsRedirect();
    } catch (err) {
      captured = (err as { url?: string }).url;
    }
    // PRD #2458 slice 4 — bookmarks issued before the IA reshape must
    // land directly on the toggle's environment dimension, NOT on a
    // client-side useEffect that briefly renders the old page first.
    expect(captured).toBe("/admin/connections?groupBy=environment");
  });
});
