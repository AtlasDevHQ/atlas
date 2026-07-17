import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

// next/link needs no router for a plain anchor render — stub it to the bare <a>.
void mock.module("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

import { ErrorShell } from "../error-shell";
import { resolveErrorContent } from "../error-content";

const TOKEN = "abc123def456ghi789jkl";

// #4690 — render-level pin of the CTA → href wiring the resolver decides. The
// resolver tests lock login-vs-home; these lock that the standalone shell turns
// that decision into the right anchors (the login-redirect-back is the AC).
describe("ErrorShell CTA wiring (#4690)", () => {
  afterEach(cleanup);

  function hrefs() {
    return screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => h !== "https://www.useatlas.dev"); // drop the attribution anchor
  }

  test("login-required renders the login redirect back to the shared view", () => {
    render(<ErrorShell token={TOKEN} content={resolveErrorContent("login-required")} />);
    const links = hrefs();
    expect(links).toContain(
      `/login?redirect=${encodeURIComponent(`/shared/dashboard/${TOKEN}`)}`,
    );
    // No login prompt on the wrong-org path is asserted below; here, no bare home CTA.
    cleanup();
  });

  test("membership-required offers 'Go to Atlas' (home) and NEVER a login link", () => {
    render(<ErrorShell token={TOKEN} content={resolveErrorContent("membership-required")} />);
    const links = hrefs();
    expect(links).toContain("/");
    expect(links.some((h) => h.startsWith("/login"))).toBe(false);
    expect(screen.getByText(/go to atlas/i)).toBeDefined();
    cleanup();
  });

  test("transient failure (server-error) shows a 'Try again' link back to the view", () => {
    render(<ErrorShell token={TOKEN} content={resolveErrorContent("server-error")} />);
    const links = hrefs();
    expect(links).toContain(`/shared/dashboard/${TOKEN}`);
    cleanup();
  });

  test("not-found shows neither a login nor a 'Try again' link — only 'Go to Atlas'", () => {
    render(<ErrorShell token={TOKEN} content={resolveErrorContent("not-found")} />);
    const links = hrefs();
    expect(links).toEqual(["/"]);
    cleanup();
  });
});
