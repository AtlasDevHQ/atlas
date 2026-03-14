import { test, expect } from "@playwright/test";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const window: any;

const API_URL = process.env.ATLAS_API_URL ?? "http://localhost:3001";

/**
 * Build a minimal HTML page that loads the widget via script tag.
 * Uses data-* attributes for configuration.
 */
function widgetPage(attrs: Record<string, string> = {}): string {
  const attrStr = Object.entries({ "data-api-url": API_URL, ...attrs })
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");

  return `<!DOCTYPE html>
<html><head><title>Widget Test</title></head>
<body>
<h1>Host Page</h1>
<script src="${API_URL}/widget.js" ${attrStr}></script>
</body></html>`;
}

test.describe("Widget Embed", () => {
  // Widget tests don't need authenticated storage state — the widget
  // manages its own auth via data-api-key / setAuthToken.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("script tag loads and creates floating bubble", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = page.locator(".atlas-wl-bubble");
    await expect(bubble).toBeVisible({ timeout: 10_000 });
    await expect(bubble).toHaveAttribute("aria-label", "Open Atlas Chat");
  });

  test("clicking bubble opens iframe with chat UI", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });
    await bubble.click();

    // Iframe container should have the open class
    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });

    // Bubble icon should switch to close (X) icon
    await expect(bubble).toHaveAttribute("aria-label", "Close Atlas Chat");

    // Iframe should exist and point to the widget host
    const iframe = frameWrap.locator("iframe");
    await expect(iframe).toBeAttached();
    const src = await iframe.getAttribute("src");
    expect(src).toContain("/widget");
  });

  test("data-theme='dark' is passed to widget iframe", async ({ page }) => {
    await page.setContent(widgetPage({ "data-theme": "dark" }));

    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });

    // The iframe src should include theme=dark
    const iframe = page.locator(".atlas-wl-frame-wrap iframe");
    const src = await iframe.getAttribute("src");
    expect(src).toContain("theme=dark");
  });

  test("data-position='bottom-left' positions bubble on the left", async ({ page }) => {
    await page.setContent(widgetPage({ "data-position": "bottom-left" }));

    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });

    // The bubble should be positioned on the left side
    const box = await bubble.boundingBox();
    expect(box).not.toBeNull();
    // Viewport is 1280px wide by default — left-positioned bubble should be
    // in the left half of the viewport (its `left` is 20px)
    expect(box!.x).toBeLessThan(640);
  });

  test("Atlas.open() opens the widget programmatically", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });

    // Widget should start closed
    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).not.toHaveClass(/atlas-wl-open/);

    // Open via programmatic API
    await page.evaluate(() => (window as any).Atlas.open());
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });
  });

  test("Atlas.close() closes the widget programmatically", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });

    // Open first
    await page.evaluate(() => (window as any).Atlas.open());
    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });

    // Close
    await page.evaluate(() => (window as any).Atlas.close());
    await expect(frameWrap).not.toHaveClass(/atlas-wl-open/);
  });

  test("Atlas.ask() opens widget and sends a query to the iframe", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });

    // Wait for the iframe to signal ready before sending a query
    const readyPromise = page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          window.addEventListener("message", function handler(e: any) {
            if (e.data?.type === "atlas:ready") {
              window.removeEventListener("message", handler);
              resolve();
            }
          });
        }),
    );

    // Open to trigger iframe load, then wait for ready
    await page.evaluate(() => (window as any).Atlas.open());
    await readyPromise;

    // Send a question via the programmatic API
    await page.evaluate(() => (window as any).Atlas.ask("test question"));

    // The widget should be open
    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });

    // Verify the query was sent to the iframe — the chat input inside the
    // iframe should have the text or a message should appear. We check via
    // the iframe's content using frameLocator.
    const frame = page.frameLocator(".atlas-wl-frame-wrap iframe");
    // The input should have been filled with the question text, or a user
    // message bubble should appear containing the question
    const userMessage = frame.locator("text=test question");
    await expect(userMessage.first()).toBeVisible({ timeout: 10_000 });
  });

  test("close button (bubble) toggles widget closed", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });

    // Open
    await bubble.click();
    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });

    // Close by clicking the bubble again (it shows X icon when open)
    await bubble.click();
    await expect(frameWrap).not.toHaveClass(/atlas-wl-open/);
    await expect(bubble).toHaveAttribute("aria-label", "Open Atlas Chat");
  });

  test("Escape key closes the widget", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });

    // Open
    await bubble.click();
    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });

    // Press Escape
    await page.keyboard.press("Escape");
    await expect(frameWrap).not.toHaveClass(/atlas-wl-open/);
  });

  test("Atlas.destroy() removes widget from DOM", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });

    await page.evaluate(() => (window as any).Atlas.destroy());

    // Bubble and frame wrapper should be removed
    await expect(bubble).toBeHidden();
    await expect(page.locator(".atlas-wl-frame-wrap")).toBeHidden();

    // window.Atlas should be deleted
    const hasAtlas = await page.evaluate(() => "Atlas" in window);
    expect(hasAtlas).toBe(false);
  });

  test("Atlas.on() receives open and close events", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = page.locator(".atlas-wl-bubble");
    await bubble.waitFor({ timeout: 10_000 });

    // Register event listeners
    await page.evaluate(() => {
      (window as any).__atlasEvents = [];
      (window as any).Atlas.on("open", () => (window as any).__atlasEvents.push("open"));
      (window as any).Atlas.on("close", () => (window as any).__atlasEvents.push("close"));
    });

    // Open
    await page.evaluate(() => (window as any).Atlas.open());
    await page.locator(".atlas-wl-frame-wrap.atlas-wl-open").waitFor({ timeout: 5_000 });

    // Close
    await page.evaluate(() => (window as any).Atlas.close());
    await expect(page.locator(".atlas-wl-frame-wrap")).not.toHaveClass(/atlas-wl-open/);

    const events = await page.evaluate(() => (window as any).__atlasEvents);
    expect(events).toEqual(["open", "close"]);
  });
});
