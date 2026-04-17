import { test, expect } from "@playwright/test";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const window: any;

const API_URL = process.env.ATLAS_API_URL ?? "http://localhost:3001";

/**
 * Widget starter-prompts override behavior — issue #1479.
 *
 * Two correctness checks:
 *
 *  1. **No prop** — the widget calls `/api/v1/starter-prompts` and renders
 *     the returned list with provenance badges (matching the web app).
 *  2. **Prop supplied** — the widget MUST NOT call the endpoint at all.
 *     This is a privacy guarantee: an embedder using overrides should not
 *     leak a user-identifying request from a host page.
 *
 * The "no network call" assertion uses `page.route` to count requests to
 * `/api/v1/starter-prompts` directly — a Playwright observation rather
 * than a fetch mock, so it captures real iframe traffic.
 */

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function widgetPage(attrs: Record<string, string> = {}): string {
  const attrStr = Object.entries({ "data-api-url": API_URL, ...attrs })
    .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
    .join(" ");

  return `<!DOCTYPE html>
<html><head><title>Widget Test</title></head>
<body>
<h1>Host Page</h1>
<script src="${API_URL}/widget.js" ${attrStr}></script>
</body></html>`;
}

test.describe("Widget starter-prompts override", () => {
  // Pure DOM/network — no auth dependency. Clear storage so global-setup
  // login doesn't add cookies that would change /api/v1/starter-prompts behavior.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("data-starter-prompts forwards through to iframe URL as starterPrompts query param", async ({
    page,
  }) => {
    const overrides = ["What is total revenue?", "Top 5 customers"];
    await page.setContent(
      widgetPage({ "data-starter-prompts": JSON.stringify(overrides) }),
    );

    // Wait for the floating bubble to be injected, then read the iframe src.
    await page.locator(".atlas-wl-bubble").waitFor({ timeout: 10_000 });

    const src = await page.locator(".atlas-wl-frame-wrap iframe").getAttribute("src");
    expect(src).toBeTruthy();
    expect(src).toContain("starterPrompts=");

    const url = new URL(src!);
    const param = url.searchParams.get("starterPrompts");
    expect(param).not.toBeNull();
    expect(JSON.parse(param!)).toEqual(overrides);
  });

  test("widget does NOT call /api/v1/starter-prompts when data-starter-prompts is supplied", async ({
    page,
  }) => {
    const overrides = ["Override prompt one", "Override prompt two"];

    // Count any request that touches /api/v1/starter-prompts. The
    // counter wraps a route handler that always continues — we only
    // observe traffic, never block it.
    const observed: string[] = [];
    await page.route("**/api/v1/starter-prompts**", async (route) => {
      observed.push(route.request().url());
      await route.continue();
    });

    await page.setContent(
      widgetPage({ "data-starter-prompts": JSON.stringify(overrides) }),
    );

    // Open the bubble so the iframe mounts the AtlasChat component and
    // would have triggered the fetch if the override were ignored.
    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });
    await bubble.click();

    const frame = page.frameLocator(".atlas-wl-frame-wrap iframe");

    // Wait for one of the override prompts to render so we know the empty
    // state has fully booted, then assert nobody called the endpoint.
    await expect(frame.getByText("Override prompt one")).toBeVisible({ timeout: 15_000 });
    await expect(frame.getByText("Override prompt two")).toBeVisible();

    expect(observed).toEqual([]);
  });

  test("widget calls /api/v1/starter-prompts when no override prop is supplied", async ({
    page,
  }) => {
    const observed: string[] = [];
    await page.route("**/api/v1/starter-prompts**", async (route) => {
      observed.push(route.request().url());
      await route.continue();
    });

    await page.setContent(widgetPage());

    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });
    await bubble.click();

    // The iframe mounts AtlasChat which triggers the starter-prompts query.
    // A real call to the endpoint should be observed within a few seconds.
    await expect.poll(() => observed.length, { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test("invalid data-starter-prompts JSON is dropped — no starterPrompts param emitted", async ({
    page,
  }) => {
    await page.setContent(
      widgetPage({ "data-starter-prompts": "not-json-at-all" }),
    );

    await page.locator(".atlas-wl-bubble").waitFor({ timeout: 10_000 });
    const src = await page.locator(".atlas-wl-frame-wrap iframe").getAttribute("src");
    expect(src).not.toContain("starterPrompts=");
  });
});
