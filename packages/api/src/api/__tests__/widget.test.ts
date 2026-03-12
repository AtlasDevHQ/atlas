/**
 * Tests for the widget host route.
 *
 * Tests HTML response, headers, query param handling, XSS prevention,
 * apiUrl sanitization, error handling infrastructure, and HTML structure.
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
  // --- Response basics ---

  it("returns 200 with text/html content type", async () => {
    const res = await app.fetch(widgetRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("returns 404 for POST requests", async () => {
    const res = await app.fetch(
      new Request("http://localhost/widget", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  // --- Security headers ---

  it("sets CSP frame-ancestors header for iframe embedding", async () => {
    const res = await app.fetch(widgetRequest());
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("frame-ancestors *");
  });

  it("sets CORS allow-origin header", async () => {
    const res = await app.fetch(widgetRequest());
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  // --- Query param handling ---

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

  it("defaults apiUrl to empty string when not specified", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('"apiUrl":""');
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

  // --- XSS prevention ---

  it("escapes < in apiUrl to prevent script injection", async () => {
    const res = await app.fetch(
      widgetRequest({ apiUrl: 'https://example.com/?q=</script><script>alert(1)</script>' }),
    );
    const html = await res.text();
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c");
  });

  it("does not include malicious theme values in the HTML", async () => {
    const res = await app.fetch(
      widgetRequest({ theme: '"><img src=x onerror=alert(1)>' }),
    );
    const html = await res.text();
    // Invalid theme falls back to "system", malicious value should not appear
    expect(html).toContain('"theme":"system"');
    expect(html).not.toContain("onerror=alert");
  });

  it("does not include malicious position values in the HTML", async () => {
    const res = await app.fetch(
      widgetRequest({ position: '"><script>alert(1)</script>' }),
    );
    const html = await res.text();
    expect(html).toContain('"position":"inline"');
    expect(html).not.toContain("<script>alert(1)");
  });

  // --- apiUrl sanitization ---

  it("rejects javascript: protocol in apiUrl", async () => {
    const res = await app.fetch(
      widgetRequest({ apiUrl: "javascript:alert(document.cookie)" }),
    );
    const html = await res.text();
    expect(html).not.toContain("javascript:");
    expect(html).toContain('"apiUrl":""');
  });

  it("rejects data: protocol in apiUrl", async () => {
    const res = await app.fetch(
      widgetRequest({ apiUrl: "data:text/html,<script>alert(1)</script>" }),
    );
    const html = await res.text();
    expect(html).not.toContain("data:text/html");
    expect(html).toContain('"apiUrl":""');
  });

  it("rejects non-URL strings in apiUrl", async () => {
    const res = await app.fetch(widgetRequest({ apiUrl: "not a url" }));
    const html = await res.text();
    expect(html).toContain('"apiUrl":""');
  });

  it("allows valid https apiUrl", async () => {
    const res = await app.fetch(
      widgetRequest({ apiUrl: "https://api.example.com" }),
    );
    const html = await res.text();
    expect(html).toContain("https://api.example.com");
  });

  it("allows valid http apiUrl", async () => {
    const res = await app.fetch(
      widgetRequest({ apiUrl: "http://localhost:3001" }),
    );
    const html = await res.text();
    expect(html).toContain("http://localhost:3001");
  });

  // --- HTML structure ---

  it("returns valid HTML document structure", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<div id="atlas-widget">');
    expect(html).toContain('<script id="atlas-config"');
  });

  it("sets data-position attribute on body", async () => {
    const res = await app.fetch(widgetRequest({ position: "bottomRight" }));
    const html = await res.text();
    expect(html).toContain('data-position="bottomRight"');
  });

  // --- Error handling infrastructure ---

  it("includes global error handlers for uncaught errors", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("window.onerror");
    expect(html).toContain("unhandledrejection");
  });

  it("includes try/catch around CDN imports", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("try{");
    expect(html).toContain("}catch(err)");
  });

  it("includes React error boundary", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("getDerivedStateFromError");
    expect(html).toContain("componentDidCatch");
  });

  it("sends atlas:ready message to parent on successful load", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("atlas:ready");
  });

  it("sends atlas:error message to parent on load failure", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("atlas:error");
    expect(html).toContain("LOAD_FAILED");
  });

  it("validates postMessage source is parent window", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("e.source!==window.parent");
  });

  // --- Component and CDN references ---

  it("includes AtlasChat component import", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("AtlasChat");
    expect(html).toContain("@useatlas/react");
  });

  it("uses Promise.all for parallel CDN imports", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("Promise.all");
  });

  it("includes postMessage listener", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('addEventListener("message"');
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
