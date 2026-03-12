/**
 * Tests for the widget host route.
 *
 * Tests HTML response, headers, query param handling, and XSS prevention.
 * The widget route has no internal dependencies, so no mocks are needed —
 * we mount it on a standalone Hono app for isolation.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";

const { widget } = await import("../routes/widget");

const app = new Hono();
app.route("/widget", widget);

function widgetRequest(params?: Record<string, string>): Request {
  const url = new URL("http://localhost/widget");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  return new Request(url.toString());
}

describe("GET /widget", () => {
  it("returns 200 with text/html content type", async () => {
    const res = await app.fetch(widgetRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("sets CSP frame-ancestors header for iframe embedding", async () => {
    const res = await app.fetch(widgetRequest());
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("frame-ancestors *");
  });

  it("sets CORS allow-origin header", async () => {
    const res = await app.fetch(widgetRequest());
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("includes config JSON with query params in response body", async () => {
    const res = await app.fetch(
      widgetRequest({ theme: "dark", apiUrl: "https://api.example.com", position: "bottomLeft" }),
    );
    const html = await res.text();
    expect(html).toContain('"theme":"dark"');
    expect(html).toContain("https://api.example.com");
    expect(html).toContain('"position":"bottomLeft"');
  });

  it("defaults theme to system when not specified", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('"theme":"system"');
  });

  it("defaults position to inline when not specified", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('"position":"inline"');
  });

  it("falls back to system for invalid theme", async () => {
    const res = await app.fetch(widgetRequest({ theme: "neon" }));
    const html = await res.text();
    expect(html).toContain('"theme":"system"');
  });

  it("falls back to inline for invalid position", async () => {
    const res = await app.fetch(widgetRequest({ position: "center" }));
    const html = await res.text();
    expect(html).toContain('"position":"inline"');
  });

  it("accepts all valid theme values", async () => {
    for (const theme of ["light", "dark", "system"]) {
      const res = await app.fetch(widgetRequest({ theme }));
      const html = await res.text();
      expect(html).toContain(`"theme":"${theme}"`);
    }
  });

  it("accepts all valid position values", async () => {
    for (const position of ["bottomRight", "bottomLeft", "inline"]) {
      const res = await app.fetch(widgetRequest({ position }));
      const html = await res.text();
      expect(html).toContain(`"position":"${position}"`);
    }
  });

  it("escapes < in apiUrl to prevent XSS", async () => {
    const res = await app.fetch(
      widgetRequest({ apiUrl: '</script><script>alert(1)</script>' }),
    );
    const html = await res.text();
    // Raw </script> must not appear — < is escaped as \u003c in JSON
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c");
  });

  it("includes postMessage listener", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('addEventListener("message"');
  });

  it("includes AtlasChat component import", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("AtlasChat");
    expect(html).toContain("@useatlas/react");
  });

  it("includes theme init script to prevent FOUC", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("atlas-theme");
    expect(html).toContain("prefers-color-scheme:dark");
  });

  it("includes design token CSS custom properties", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain(".atlas-root{");
    expect(html).toContain("--background:");
    expect(html).toContain(".dark .atlas-root{");
  });
});
