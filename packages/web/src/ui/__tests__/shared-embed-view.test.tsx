import { describe, expect, test, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import {
  EmbedView,
  EmbedErrorView,
  resolveEmbedTheme,
  resolveEmbedHeading,
} from "../../app/shared/[token]/embed/view";
import type { SharedConversation } from "../../app/shared/lib";

afterEach(() => cleanup());

function convo(over: Partial<SharedConversation> = {}): SharedConversation {
  return {
    title: "Top customers by revenue",
    surface: "web",
    createdAt: "2026-04-26T00:00:00Z",
    messages: [
      {
        role: "user",
        content: "Who are our top 10 customers by revenue last quarter?",
        createdAt: "2026-04-26T00:00:00Z",
      },
      {
        role: "assistant",
        content: "Here are the top three: **Acme Corp**, Globex, Initech.",
        createdAt: "2026-04-26T00:00:01Z",
      },
    ],
    notebookState: null,
    ...over,
  };
}

describe("resolveEmbedTheme", () => {
  test("dark when ?theme=dark", () => {
    expect(resolveEmbedTheme("dark")).toBe("dark");
  });
  test("light otherwise (light, missing, garbage)", () => {
    expect(resolveEmbedTheme("light")).toBe("light");
    expect(resolveEmbedTheme(undefined)).toBe("light");
    expect(resolveEmbedTheme("hot-pink")).toBe("light");
  });
  test("first value wins when array passed (Next can yield string[])", () => {
    expect(resolveEmbedTheme(["dark", "light"])).toBe("dark");
    expect(resolveEmbedTheme(["light", "dark"])).toBe("light");
  });
});

describe("resolveEmbedHeading", () => {
  test("returns title when set", () => {
    expect(resolveEmbedHeading(convo({ title: "Q1 revenue" }))).toBe(
      "Q1 revenue",
    );
  });
  test("falls back to first user message when title missing", () => {
    const heading = resolveEmbedHeading(convo({ title: null }));
    expect(heading).toBe("Who are our top 10 customers by revenue last quarter?");
  });
  test("falls back to static label when title null and no user messages", () => {
    expect(
      resolveEmbedHeading(
        convo({
          title: null,
          messages: [
            {
              role: "assistant",
              content: "ack",
              createdAt: "2026-04-26T00:00:00Z",
            },
          ],
        }),
      ),
    ).toBe("Atlas Conversation");
  });
  test("truncates very long fallback text", () => {
    const long = "x".repeat(200);
    const heading = resolveEmbedHeading(
      convo({
        title: null,
        messages: [
          { role: "user", content: long, createdAt: "2026-04-26T00:00:00Z" },
        ],
      }),
    );
    expect(heading.length).toBeLessThanOrEqual(80);
    expect(heading).toEndWith("…");
  });
});

describe("<EmbedView>", () => {
  test("renders an h1 (sr-only) with the resolved heading", () => {
    const { container } = render(
      <EmbedView data={convo({ title: "Atlas demo" })} theme="light" />,
    );
    const h1 = container.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toBe("Atlas demo");
    expect(h1?.className).toContain("sr-only");
  });

  test("renders a <main id='main'> as the global skip-link target", () => {
    const { container } = render(
      <EmbedView data={convo()} theme="light" />,
    );
    const main = container.querySelector("main#main");
    expect(main).not.toBeNull();
    expect(main?.getAttribute("tabIndex")).toBe("-1");
  });

  test("renders the Read-only chip in the header chrome", () => {
    const { container } = render(<EmbedView data={convo()} theme="light" />);
    expect(container.textContent).toContain("Read-only");
  });

  test("renders the Atlas brand wordmark in the header", () => {
    const { container } = render(<EmbedView data={convo()} theme="light" />);
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain("Atlas");
  });

  test("renders the 'Powered by Atlas' attribution footer", () => {
    const { container } = render(<EmbedView data={convo()} theme="light" />);
    const footer = container.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer?.textContent).toContain("Powered by Atlas");
    const link = footer?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://www.useatlas.dev");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  test("does NOT render a 'Try Atlas free' CTA inside the embed (contract)", () => {
    // The embed is rendered inside someone else's product. A pushy CTA inside
    // their UX is a contract break — locked in via this assertion.
    const { container } = render(<EmbedView data={convo()} theme="light" />);
    expect(container.textContent).not.toContain("Try Atlas free");
  });

  test("filters tool / system messages out of the visible turns", () => {
    const data = convo({
      messages: [
        { role: "user", content: "q", createdAt: "2026-04-26T00:00:00Z" },
        { role: "tool", content: "internal", createdAt: "2026-04-26T00:00:01Z" },
        { role: "system", content: "internal", createdAt: "2026-04-26T00:00:02Z" },
        { role: "assistant", content: "a", createdAt: "2026-04-26T00:00:03Z" },
      ],
    });
    const { container } = render(<EmbedView data={data} theme="light" />);
    expect(container.textContent).not.toContain("internal");
  });

  test("filters out empty-content user / assistant messages", () => {
    const data = convo({
      messages: [
        { role: "user", content: "   ", createdAt: "2026-04-26T00:00:00Z" },
        { role: "assistant", content: "kept", createdAt: "2026-04-26T00:00:01Z" },
      ],
    });
    const { container } = render(<EmbedView data={data} theme="light" />);
    const articles = container.querySelectorAll("article");
    expect(articles.length).toBe(1);
    expect(articles[0]?.getAttribute("aria-label")).toBe("Atlas response");
  });

  test("shows empty-content fallback when no readable turns survive filtering", () => {
    const data = convo({
      messages: [
        { role: "tool", content: "internal", createdAt: "2026-04-26T00:00:00Z" },
      ],
    });
    const { container } = render(<EmbedView data={data} theme="light" />);
    expect(container.textContent).toContain("This conversation has no readable content.");
  });

  test("each rendered turn is an <article> with role-specific aria-label", () => {
    const { container } = render(<EmbedView data={convo()} theme="light" />);
    const articles = container.querySelectorAll("article");
    expect(articles.length).toBe(2);
    expect(articles[0]?.getAttribute("aria-label")).toBe("User message");
    expect(articles[1]?.getAttribute("aria-label")).toBe("Atlas response");
  });

  test("wraps the shell in a `.dark` ancestor when theme=dark", () => {
    // Tailwind dark variant is `&:is(.dark *)` — only descendants of `.dark`
    // pick up dark styles. This locks in the wrapper-dance.
    const { container } = render(<EmbedView data={convo()} theme="dark" />);
    const outer = container.querySelector('[data-theme="dark"]');
    expect(outer).not.toBeNull();
    expect(outer?.classList.contains("dark")).toBe(true);
  });

  test("does NOT add `.dark` when theme=light", () => {
    const { container } = render(<EmbedView data={convo()} theme="light" />);
    const outer = container.querySelector('[data-theme="light"]');
    expect(outer?.classList.contains("dark")).toBe(false);
  });
});

describe("<EmbedErrorView>", () => {
  test("renders the same chrome (header + main + footer) as the success view", () => {
    const { container } = render(
      <EmbedErrorView reason="not-found" theme="light" />,
    );
    expect(container.querySelector("header")).not.toBeNull();
    expect(container.querySelector("main#main")).not.toBeNull();
    expect(container.querySelector("footer")).not.toBeNull();
    expect(container.textContent).toContain("Powered by Atlas");
  });

  test("renders an h1 (sr-only) so heading-order stays sequential", () => {
    const { container } = render(
      <EmbedErrorView reason="not-found" theme="light" />,
    );
    const h1 = container.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1?.className).toContain("sr-only");
  });

  test("uses a distinct message per reason", () => {
    const cases: { reason: "not-found" | "server-error" | "network-error"; needle: string }[] = [
      { reason: "not-found", needle: "not found" },
      { reason: "network-error", needle: "Could not reach" },
      { reason: "server-error", needle: "Could not load" },
    ];
    for (const { reason, needle } of cases) {
      cleanup();
      const { container } = render(
        <EmbedErrorView reason={reason} theme="light" />,
      );
      expect(container.textContent?.toLowerCase()).toContain(
        needle.toLowerCase(),
      );
    }
  });
});
