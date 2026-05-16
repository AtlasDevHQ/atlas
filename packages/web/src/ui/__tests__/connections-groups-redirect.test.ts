import { describe, expect, mock, test } from "bun:test";

mock.module("next/navigation", () => ({
  redirect: (url: string) => {
    // `next/navigation`'s redirect() throws to halt rendering — tag the
    // thrown error with the URL so the test can assert on it.
    const err = new Error("NEXT_REDIRECT") as Error & { url: string };
    err.url = url;
    throw err;
  },
}));

// Dynamic import after the mock so the page picks up the stub.
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
    // Old bookmarks must land directly on the env tab, not a client
    // useEffect that briefly renders the old page first.
    expect(captured).toBe("/admin/connections?groupBy=environment");
  });
});
