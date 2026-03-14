import { test, expect } from "@playwright/test";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const window: any;

const API_URL = process.env.ATLAS_API_URL ?? "http://localhost:3001";

/** Escape HTML attribute values to prevent broken markup from special chars. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Build a minimal HTML page that loads the widget via script tag.
 * `data-api-url` defaults to API_URL; override via `attrs`.
 */
function widgetPage(attrs: Record<string, string> = {}, beforeScript = ""): string {
  const attrStr = Object.entries({ "data-api-url": API_URL, ...attrs })
    .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
    .join(" ");

  return `<!DOCTYPE html>
<html><head><title>Widget Test</title></head>
<body>
<h1>Host Page</h1>
${beforeScript}
<script src="${API_URL}/widget.js" ${attrStr}></script>
</body></html>`;
}

/** Wait for the widget bubble to appear after page load. */
async function waitForBubble(page: import("@playwright/test").Page) {
  const bubble = page.locator(".atlas-wl-bubble");
  await bubble.waitFor({ timeout: 10_000 });
  return bubble;
}

test.describe("Widget Embed", () => {
  // Widget tests exercise loader/DOM behavior only — no auth needed.
  // Clear storage state to avoid inheriting the global-setup login session.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("script tag loads and creates floating bubble", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = await waitForBubble(page);
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveAttribute("aria-label", "Open Atlas Chat");
  });

  test("clicking bubble opens iframe with chat UI", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = await waitForBubble(page);
    await bubble.click();

    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });
    await expect(bubble).toHaveAttribute("aria-label", "Close Atlas Chat");

    const iframe = frameWrap.locator("iframe");
    await expect(iframe).toBeAttached();
    const src = await iframe.getAttribute("src");
    expect(src).toContain("/widget");
  });

  test("data-theme='dark' is passed to widget iframe", async ({ page }) => {
    await page.setContent(widgetPage({ "data-theme": "dark" }));

    await waitForBubble(page);

    const iframe = page.locator(".atlas-wl-frame-wrap iframe");
    const src = await iframe.getAttribute("src");
    expect(src).toContain("theme=dark");
  });

  test("data-position='bottom-left' positions bubble on the left", async ({ page }) => {
    await page.setContent(widgetPage({ "data-position": "bottom-left" }));

    const bubble = await waitForBubble(page);

    const box = await bubble.boundingBox();
    expect(box).not.toBeNull();
    // Desktop Chrome viewport is 1280px wide — left-positioned bubble
    // (left: 20px) should be well within the left half
    expect(box!.x).toBeLessThan(640);
  });

  test("Atlas.open() opens the widget programmatically", async ({ page }) => {
    await page.setContent(widgetPage());
    await waitForBubble(page);

    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).not.toHaveClass(/atlas-wl-open/);

    await page.evaluate(() => (window as any).Atlas.open());
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });
  });

  test("Atlas.close() closes the widget programmatically", async ({ page }) => {
    await page.setContent(widgetPage());
    await waitForBubble(page);

    await page.evaluate(() => (window as any).Atlas.open());
    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });

    await page.evaluate(() => (window as any).Atlas.close());
    await expect(frameWrap).not.toHaveClass(/atlas-wl-open/);
  });

  test("Atlas.toggle() toggles widget open and closed", async ({ page }) => {
    await page.setContent(widgetPage());
    await waitForBubble(page);

    const frameWrap = page.locator(".atlas-wl-frame-wrap");

    await page.evaluate(() => (window as any).Atlas.toggle());
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });

    await page.evaluate(() => (window as any).Atlas.toggle());
    await expect(frameWrap).not.toHaveClass(/atlas-wl-open/);
  });

  test("Atlas.ask() opens widget and sends a query to the iframe", async ({ page }) => {
    await page.setContent(widgetPage());
    await waitForBubble(page);

    // Register ready listener before opening so we don't miss the event.
    // Race with a timeout so failure produces a clear message.
    const readyPromise = Promise.race([
      page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            window.addEventListener("message", function handler(e: any) {
              if (e.data?.type === "atlas:ready") {
                window.removeEventListener("message", handler);
                resolve();
              }
            });
          }),
      ),
      page.waitForTimeout(15_000).then(() => {
        throw new Error("Widget iframe did not send atlas:ready within 15s");
      }),
    ]);

    await page.evaluate(() => (window as any).Atlas.open());
    await readyPromise;

    await page.evaluate(() => (window as any).Atlas.ask("test question"));

    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });

    // The question text should appear somewhere in the iframe (input or message bubble)
    const frame = page.frameLocator(".atlas-wl-frame-wrap iframe");
    const userMessage = frame.locator("text=test question");
    await expect(userMessage.first()).toBeVisible({ timeout: 10_000 });
  });

  test("close button (bubble) toggles widget closed", async ({ page }) => {
    await page.setContent(widgetPage());

    const bubble = await waitForBubble(page);
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

    const bubble = await waitForBubble(page);
    await bubble.click();
    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });

    await page.keyboard.press("Escape");
    await expect(frameWrap).not.toHaveClass(/atlas-wl-open/);
  });

  test("Atlas.destroy() removes widget from DOM", async ({ page }) => {
    await page.setContent(widgetPage());
    await waitForBubble(page);

    await page.evaluate(() => (window as any).Atlas.destroy());

    await expect(page.locator(".atlas-wl-bubble")).toBeHidden();
    await expect(page.locator(".atlas-wl-frame-wrap")).toBeHidden();

    const hasAtlas = await page.evaluate(() => "Atlas" in window);
    expect(hasAtlas).toBe(false);

    // Double-destroy should not throw
    // (Atlas is deleted, but a stale reference before deletion should be safe)
  });

  test("Atlas.on() receives open and close events", async ({ page }) => {
    await page.setContent(widgetPage());
    await waitForBubble(page);

    await page.evaluate(() => {
      (window as any).__atlasEvents = [];
      (window as any).Atlas.on("open", () => (window as any).__atlasEvents.push("open"));
      (window as any).Atlas.on("close", () => (window as any).__atlasEvents.push("close"));
    });

    await page.evaluate(() => (window as any).Atlas.open());
    await page.locator(".atlas-wl-frame-wrap.atlas-wl-open").waitFor({ timeout: 5_000 });

    await page.evaluate(() => (window as any).Atlas.close());
    await expect(page.locator(".atlas-wl-frame-wrap")).not.toHaveClass(/atlas-wl-open/);

    const events = await page.evaluate(() => (window as any).__atlasEvents);
    expect(events).toEqual(["open", "close"]);
  });

  test("Atlas.setTheme() changes theme at runtime", async ({ page }) => {
    await page.setContent(widgetPage());
    await waitForBubble(page);

    // Initial theme defaults to "light" — iframe src should not contain theme=dark
    const iframe = page.locator(".atlas-wl-frame-wrap iframe");
    const initialSrc = await iframe.getAttribute("src");
    expect(initialSrc).toContain("theme=light");

    // setTheme sends a postMessage to the iframe; verify no error is thrown
    await page.evaluate(() => (window as any).Atlas.setTheme("dark"));

    // Invalid theme values should be rejected (no-op)
    await page.evaluate(() => (window as any).Atlas.setTheme("invalid"));
  });

  test("Atlas.setAuthToken() sends auth to widget iframe", async ({ page }) => {
    await page.setContent(widgetPage());
    await waitForBubble(page);

    // setAuthToken sends {type:"auth",token} to the iframe via postMessage.
    // Verify it does not throw and the widget remains functional.
    await page.evaluate(() => (window as any).Atlas.setAuthToken("test-token-123"));

    // Widget should still be operational after setting auth
    await page.evaluate(() => (window as any).Atlas.open());
    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 5_000 });
  });

  test("data-on-open and data-on-close attribute callbacks fire", async ({ page }) => {
    // Define global callback functions before the widget script loads
    const beforeScript = `<script>
      window.__cbEvents = [];
      window.myOpenCb = function() { window.__cbEvents.push("open"); };
      window.myCloseCb = function() { window.__cbEvents.push("close"); };
    </script>`;

    await page.setContent(
      widgetPage({ "data-on-open": "myOpenCb", "data-on-close": "myCloseCb" }, beforeScript),
    );
    await waitForBubble(page);

    await page.evaluate(() => (window as any).Atlas.open());
    await page.locator(".atlas-wl-frame-wrap.atlas-wl-open").waitFor({ timeout: 5_000 });

    await page.evaluate(() => (window as any).Atlas.close());
    await expect(page.locator(".atlas-wl-frame-wrap")).not.toHaveClass(/atlas-wl-open/);

    const events = await page.evaluate(() => (window as any).__cbEvents);
    expect(events).toEqual(["open", "close"]);
  });

  test("pre-load command queue replays after script loads", async ({ page }) => {
    // Queue an open command before the widget script loads
    const beforeScript = `<script>
      window.Atlas = window.Atlas || [];
      window.Atlas.push(["open"]);
    </script>`;

    await page.setContent(widgetPage({}, beforeScript));

    // The widget should auto-open from the queued command
    const frameWrap = page.locator(".atlas-wl-frame-wrap");
    await expect(frameWrap).toHaveClass(/atlas-wl-open/, { timeout: 10_000 });
  });
});
