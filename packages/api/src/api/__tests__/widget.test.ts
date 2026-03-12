/**
 * Tests for the widget host route.
 *
 * Tests HTML response, headers, query param handling, XSS prevention,
 * apiUrl sanitization, branding params, postMessage API, error handling,
 * HTML structure, data-atlas-* selectors, and asset routes. Runtime behavior
 * of inline JS (DOM manipulation, postMessage handlers) requires
 * browser-level (Playwright) testing.
 * The widget route has no internal dependencies, so no mocks are needed —
 * we mount it on a standalone Hono app for isolation.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";

const { widget, sanitizeLogoUrl, sanitizeAccent } = await import(
  "../routes/widget"
);

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
      widgetRequest({
        theme: "dark",
        apiUrl: "https://api.example.com",
        position: "bottomLeft",
      }),
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
      widgetRequest({
        apiUrl:
          'https://example.com/?q=</script><script>alert(1)</script>',
      }),
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
      widgetRequest({
        apiUrl: "data:text/html,<script>alert(1)</script>",
      }),
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

  // --- No external CDN dependencies ---

  it("does not reference any external CDN URLs", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).not.toContain("esm.sh");
    expect(html).not.toContain("cdn.tailwindcss.com");
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toContain("unpkg.com");
  });

  it("references self-hosted widget bundle and CSS", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('src="widget/atlas-widget.js"');
    expect(html).toContain('href="widget/atlas-widget.css"');
  });

  // --- Error handling infrastructure ---

  it("includes global error handlers for uncaught errors", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("window.onerror");
    expect(html).toContain("unhandledrejection");
  });

  it("includes try/catch around widget initialization", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("try{");
    expect(html).toContain("}catch(err)");
  });

  it("guards against missing AtlasWidget global before destructuring", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('typeof AtlasWidget==="undefined"');
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

  // --- Component references ---

  it("includes AtlasChat component usage", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("AtlasChat");
  });

  it("destructures widget bundle globals", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("AtlasWidget");
    expect(html).toContain("createElement");
    expect(html).toContain("createRoot");
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

// --- data-atlas-* stable selectors ---

describe("data-atlas-* selectors", () => {
  it("uses data-atlas-logo for logo replacement", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("[data-atlas-logo]");
    // Must NOT contain the old fragile SVG viewBox selector
    expect(html).not.toContain("svg[viewBox=");
  });

  it("uses data-atlas-messages for welcome message insertion", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("[data-atlas-messages]");
    // Must NOT contain the old Radix internal attribute selector
    expect(html).not.toContain("data-radix-scroll-area-viewport");
  });

  it("uses data-atlas-input for input element queries", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("[data-atlas-input]");
    // Must NOT use bare querySelector("input") for element lookup
    expect(html).not.toContain('querySelector("input")');
  });

  it("uses data-atlas-form for form submission", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("[data-atlas-form]");
    // Must NOT use input.closest("form") pattern
    expect(html).not.toContain('closest("form")');
  });

  it("waitForReady polls for data-atlas-input (not bare input)", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("waitForReady");
    // The waitForReady function should look for [data-atlas-input]
    const waitForReadyMatch = html.match(/function waitForReady[\s\S]*?setTimeout/);
    expect(waitForReadyMatch).toBeTruthy();
    expect(waitForReadyMatch![0]).toContain("[data-atlas-input]");
  });
});

// --- Branding: logo ---

describe("branding — logo", () => {
  it("includes logo URL in config when valid HTTPS", async () => {
    const res = await app.fetch(
      widgetRequest({ logo: "https://example.com/logo.png" }),
    );
    const html = await res.text();
    expect(html).toContain("https://example.com/logo.png");
    expect(html).toContain('"logo":"https://example.com/logo.png"');
  });

  it("defaults logo to empty string when not specified", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('"logo":""');
  });

  it("rejects http logo URLs (must be HTTPS)", async () => {
    const res = await app.fetch(
      widgetRequest({ logo: "http://example.com/logo.png" }),
    );
    const html = await res.text();
    expect(html).toContain('"logo":""');
  });

  it("rejects javascript: protocol in logo", async () => {
    const res = await app.fetch(
      widgetRequest({ logo: "javascript:alert(1)" }),
    );
    const html = await res.text();
    expect(html).not.toContain("javascript:");
    expect(html).toContain('"logo":""');
  });

  it("rejects data: protocol in logo", async () => {
    const res = await app.fetch(
      widgetRequest({ logo: "data:image/svg+xml,<svg></svg>" }),
    );
    const html = await res.text();
    expect(html).not.toContain("data:image");
    expect(html).toContain('"logo":""');
  });

  it("rejects invalid URL in logo", async () => {
    const res = await app.fetch(
      widgetRequest({ logo: "not-a-url" }),
    );
    const html = await res.text();
    expect(html).toContain('"logo":""');
  });

  it("escapes < in logo URL to prevent script injection", async () => {
    const res = await app.fetch(
      widgetRequest({
        logo: 'https://example.com/logo.png?x=</script><script>alert(1)</script>',
      }),
    );
    const html = await res.text();
    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c");
  });

  it("includes applyLogo function in widget script", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("applyLogo");
  });
});

// --- Branding: accent ---

describe("branding — accent", () => {
  it("includes accent color in config when valid 6-digit hex", async () => {
    const res = await app.fetch(widgetRequest({ accent: "4f46e5" }));
    const html = await res.text();
    expect(html).toContain('"accent":"4f46e5"');
  });

  it("includes accent color in config when valid 3-digit hex", async () => {
    const res = await app.fetch(widgetRequest({ accent: "f00" }));
    const html = await res.text();
    expect(html).toContain('"accent":"f00"');
  });

  it("generates accent CSS when accent is provided", async () => {
    const res = await app.fetch(widgetRequest({ accent: "4f46e5" }));
    const html = await res.text();
    expect(html).toContain("#4f46e5");
    expect(html).toContain(".atlas-accent");
    expect(html).toContain('button[type="submit"]');
  });

  it("does not generate accent CSS rules in <style> when accent is missing", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    // The <style> block should not contain accent override rules (the JS still references the class)
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch).toBeTruthy();
    expect(styleMatch![1]).not.toContain("atlas-accent");
  });

  it("defaults accent to empty string when not specified", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('"accent":""');
  });

  it("rejects invalid hex values", async () => {
    const res = await app.fetch(widgetRequest({ accent: "xyz123" }));
    const html = await res.text();
    expect(html).toContain('"accent":""');
  });

  it("rejects hex with # prefix", async () => {
    const res = await app.fetch(widgetRequest({ accent: "#4f46e5" }));
    const html = await res.text();
    expect(html).toContain('"accent":""');
  });

  it("rejects CSS injection attempts in accent", async () => {
    const res = await app.fetch(
      widgetRequest({ accent: "4f46e5;background:url(evil)" }),
    );
    const html = await res.text();
    expect(html).toContain('"accent":""');
    expect(html).not.toContain("url(evil)");
  });

  it("accepts case-insensitive hex values", async () => {
    const res = await app.fetch(widgetRequest({ accent: "FF00aa" }));
    const html = await res.text();
    expect(html).toContain('"accent":"FF00aa"');
  });
});

// --- Branding: welcome ---

describe("branding — welcome", () => {
  it("includes welcome message in config", async () => {
    const res = await app.fetch(
      widgetRequest({ welcome: "Ask about your data" }),
    );
    const html = await res.text();
    expect(html).toContain("Ask about your data");
  });

  it("defaults welcome to empty string when not specified", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('"welcome":""');
  });

  it("escapes < in welcome message to prevent XSS", async () => {
    const res = await app.fetch(
      widgetRequest({
        welcome: '</script><script>alert("xss")</script>',
      }),
    );
    const html = await res.text();
    expect(html).not.toContain('</script><script>alert("xss")</script>');
    expect(html).toContain("\\u003c");
  });

  it("includes welcome message CSS classes", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("atlas-welcome-msg");
    expect(html).toContain("atlas-welcome-inner");
  });

  it("includes applyWelcome function in widget script", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("applyWelcome");
  });

  it("truncates welcome message to 500 characters", async () => {
    const longWelcome = "b".repeat(600);
    const res = await app.fetch(widgetRequest({ welcome: longWelcome }));
    const html = await res.text();
    expect(html).toContain('"welcome":"' + "b".repeat(500) + '"');
    expect(html).not.toContain("b".repeat(501));
  });
});

// --- Branding: initialQuery ---

describe("branding — initialQuery", () => {
  it("includes initialQuery in config", async () => {
    const res = await app.fetch(
      widgetRequest({ initialQuery: "Show me revenue by month" }),
    );
    const html = await res.text();
    expect(html).toContain("Show me revenue by month");
  });

  it("defaults initialQuery to empty string when not specified", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('"initialQuery":""');
  });

  it("escapes < in initialQuery to prevent XSS", async () => {
    const res = await app.fetch(
      widgetRequest({
        initialQuery: '<img src=x onerror=alert(1)>',
      }),
    );
    const html = await res.text();
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("\\u003c");
  });

  it("includes initialQuerySent guard to prevent re-sends", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("initialQuerySent");
  });

  it("includes submitQuery function in widget script", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("submitQuery");
  });

  it("truncates initialQuery to 500 characters", async () => {
    const longQuery = "a".repeat(600);
    const res = await app.fetch(widgetRequest({ initialQuery: longQuery }));
    const html = await res.text();
    expect(html).toContain('"initialQuery":"' + "a".repeat(500) + '"');
    expect(html).not.toContain("a".repeat(501));
  });

  it("includes waitForReady polling instead of fixed setTimeout", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("waitForReady");
  });
});

// --- postMessage branding API ---

describe("postMessage branding API", () => {
  it("includes atlas:setBranding handler in widget script", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("atlas:setBranding");
  });

  it("includes atlas:ask handler in widget script", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain("atlas:ask");
  });

  it("validates logo URL protocol in setBranding handler", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    // The handler checks protocol==="https:" for logos received via postMessage
    expect(html).toContain('protocol==="https:"');
  });

  it("validates accent hex in setBranding handler", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    // The handler uses HEX_RE for runtime accent validation
    expect(html).toContain("HEX_RE");
  });
});

// --- Combined branding params ---

describe("combined branding params", () => {
  it("all branding params work together", async () => {
    const res = await app.fetch(
      widgetRequest({
        logo: "https://example.com/logo.png",
        accent: "4f46e5",
        welcome: "Ask about your data",
        initialQuery: "Show me revenue",
      }),
    );
    const html = await res.text();
    expect(html).toContain('"logo":"https://example.com/logo.png"');
    expect(html).toContain('"accent":"4f46e5"');
    expect(html).toContain('"welcome":"Ask about your data"');
    expect(html).toContain('"initialQuery":"Show me revenue"');
    // Accent CSS should be present
    expect(html).toContain("#4f46e5");
    expect(html).toContain(".atlas-accent");
  });

  it("branding params coexist with existing params", async () => {
    const res = await app.fetch(
      widgetRequest({
        theme: "dark",
        apiUrl: "https://api.example.com",
        position: "bottomRight",
        logo: "https://example.com/logo.png",
        accent: "e11d48",
        welcome: "Hello!",
      }),
    );
    const html = await res.text();
    expect(html).toContain('"theme":"dark"');
    expect(html).toContain('"apiUrl":"https://api.example.com"');
    expect(html).toContain('"position":"bottomRight"');
    expect(html).toContain('"logo":"https://example.com/logo.png"');
    expect(html).toContain('"accent":"e11d48"');
    expect(html).toContain('"welcome":"Hello!"');
  });

  it("gracefully handles all missing branding params", async () => {
    const res = await app.fetch(widgetRequest());
    const html = await res.text();
    expect(html).toContain('"logo":""');
    expect(html).toContain('"accent":""');
    expect(html).toContain('"welcome":""');
    expect(html).toContain('"initialQuery":""');
    // No accent CSS rules should be generated in the <style> block
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch).toBeTruthy();
    expect(styleMatch![1]).not.toContain("atlas-accent");
  });
});

// --- Widget asset routes ---

describe("widget asset routes", () => {
  it("GET /widget/atlas-widget.js returns JS content", async () => {
    const res = await app.fetch(
      new Request("http://localhost/widget/atlas-widget.js"),
    );
    // May be 200 (bundle built) or 404 (not built in CI).
    // In either case, the route exists and responds.
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(res.headers.get("cache-control")).toContain("public");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    } else {
      const body = await res.text();
      expect(body).toContain("bun run build");
    }
  });

  it("GET /widget/atlas-widget.css returns CSS content", async () => {
    const res = await app.fetch(
      new Request("http://localhost/widget/atlas-widget.css"),
    );
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers.get("content-type")).toContain("css");
      expect(res.headers.get("cache-control")).toContain("public");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    } else {
      const body = await res.text();
      expect(body).toContain("bun run build");
    }
  });
});

// --- Sanitization function unit tests ---

describe("sanitizeLogoUrl", () => {
  it("allows valid HTTPS URLs", () => {
    expect(sanitizeLogoUrl("https://example.com/logo.png")).toBe(
      "https://example.com/logo.png",
    );
  });

  it("rejects HTTP URLs", () => {
    expect(sanitizeLogoUrl("http://example.com/logo.png")).toBe("");
  });

  it("rejects javascript: URLs", () => {
    expect(sanitizeLogoUrl("javascript:alert(1)")).toBe("");
  });

  it("rejects data: URLs", () => {
    expect(sanitizeLogoUrl("data:image/png;base64,abc")).toBe("");
  });

  it("returns empty for invalid URLs", () => {
    expect(sanitizeLogoUrl("not a url")).toBe("");
  });

  it("returns empty for empty string", () => {
    expect(sanitizeLogoUrl("")).toBe("");
  });
});

describe("sanitizeAccent", () => {
  it("allows valid 6-digit hex", () => {
    expect(sanitizeAccent("4f46e5")).toBe("4f46e5");
  });

  it("allows valid 3-digit hex", () => {
    expect(sanitizeAccent("f00")).toBe("f00");
  });

  it("allows uppercase hex", () => {
    expect(sanitizeAccent("FF00AA")).toBe("FF00AA");
  });

  it("allows mixed case hex", () => {
    expect(sanitizeAccent("aB12cD")).toBe("aB12cD");
  });

  it("rejects hex with # prefix", () => {
    expect(sanitizeAccent("#4f46e5")).toBe("");
  });

  it("rejects 1-2 digit hex", () => {
    expect(sanitizeAccent("4f")).toBe("");
  });

  it("rejects 4-5 digit hex", () => {
    expect(sanitizeAccent("4f46e")).toBe("");
  });

  it("rejects 7+ digit hex", () => {
    expect(sanitizeAccent("4f46e5f")).toBe("");
  });

  it("rejects 8-digit RGBA hex", () => {
    expect(sanitizeAccent("4f46e5ff")).toBe("");
  });

  it("rejects non-hex characters", () => {
    expect(sanitizeAccent("xyz123")).toBe("");
  });

  it("rejects CSS injection", () => {
    expect(sanitizeAccent("4f46e5;background:red")).toBe("");
  });

  it("returns empty for empty string", () => {
    expect(sanitizeAccent("")).toBe("");
  });
});
