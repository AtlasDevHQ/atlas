/**
 * Tests for the widget loader route (widget.js + widget.d.ts).
 *
 * Tests the Hono route (response headers, content type, caching) and the
 * generated IIFE script (config parsing, iframe construction, postMessage
 * bridge, IIFE encapsulation, accessibility attributes, programmatic API,
 * event system, command queue replay, and destroy cleanup).
 *
 * No mocks needed — the route has no internal dependencies.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";

const { widgetLoader, widgetTypesLoader } = await import(
  "../routes/widget-loader"
);

const app = new Hono();
app.route("/widget.js", widgetLoader);
app.route("/widget.d.ts", widgetTypesLoader);

function loaderRequest(): Request {
  return new Request("http://localhost/widget.js");
}

async function getScript(): Promise<string> {
  const res = await app.fetch(loaderRequest());
  return res.text();
}

async function getTypes(): Promise<string> {
  const res = await app.fetch(new Request("http://localhost/widget.d.ts"));
  return res.text();
}

describe("GET /widget.js", () => {
  // --- Response basics ---

  it("returns 200 with application/javascript content type", async () => {
    const res = await app.fetch(loaderRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
  });

  it("returns 404 for POST requests", async () => {
    const res = await app.fetch(
      new Request("http://localhost/widget.js", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  it("sets CORS allow-origin header for cross-origin loading", async () => {
    const res = await app.fetch(loaderRequest());
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("sets cache-control header for CDN caching", async () => {
    const res = await app.fetch(loaderRequest());
    const cc = res.headers.get("cache-control");
    expect(cc).toContain("public");
    expect(cc).toContain("max-age=");
  });

  // --- IIFE structure ---

  it("wraps script in an IIFE", async () => {
    const script = await getScript();
    expect(script.startsWith("(function(){")).toBe(true);
    expect(script.endsWith("})();")).toBe(true);
  });

  it("uses strict mode", async () => {
    const script = await getScript();
    expect(script).toContain('"use strict"');
  });

  // --- Config parsing ---

  it("reads data-api-url from script tag", async () => {
    const script = await getScript();
    expect(script).toContain('s.getAttribute("data-api-url")');
  });

  it("reads data-api-key from script tag", async () => {
    const script = await getScript();
    expect(script).toContain('s.getAttribute("data-api-key")');
  });

  it("reads data-theme from script tag", async () => {
    const script = await getScript();
    expect(script).toContain('s.getAttribute("data-theme")');
  });

  it("reads data-position from script tag", async () => {
    const script = await getScript();
    expect(script).toContain('s.getAttribute("data-position")');
  });

  it("defaults theme to light", async () => {
    const script = await getScript();
    // Validates theme is light or dark, defaults to light
    expect(script).toContain('"light"');
    expect(script).toContain('"dark"');
  });

  it("defaults position to bottom-right", async () => {
    const script = await getScript();
    expect(script).toContain('"bottom-right"');
    expect(script).toContain('"bottom-left"');
  });

  it("requires data-api-url and errors without it", async () => {
    const script = await getScript();
    expect(script).toContain("data-api-url attribute is required");
  });

  it("validates apiUrl protocol is http or https", async () => {
    const script = await getScript();
    expect(script).toContain('u.protocol!=="https:"&&u.protocol!=="http:"');
    expect(script).toContain("data-api-url must use http or https");
  });

  it("guards against missing document.currentScript", async () => {
    const script = await getScript();
    expect(script).toContain("widget.js must be loaded via a <script> tag");
  });

  it("handles invalid data-api-url with error message", async () => {
    const script = await getScript();
    expect(script).toContain("Invalid data-api-url");
  });

  // --- Iframe construction ---

  it("creates iframe with /widget path as src", async () => {
    const script = await getScript();
    expect(script).toContain("/widget?position=inline&theme=");
  });

  it("passes theme as query param to iframe src", async () => {
    const script = await getScript();
    expect(script).toContain("encodeURIComponent(theme)");
  });

  it("does not leak apiKey in iframe URL (uses postMessage instead)", async () => {
    const script = await getScript();
    expect(script).not.toContain("&apiKey=");
    // Auth is delivered securely via postMessage on atlas:ready
    expect(script).toContain('{type:"auth",token:apiKey}');
  });

  it("sets iframe title for accessibility", async () => {
    const script = await getScript();
    expect(script).toContain('"title","Atlas Chat"');
  });

  it("sets clipboard-write permission on iframe", async () => {
    const script = await getScript();
    expect(script).toContain('"allow","clipboard-write"');
  });

  it("strips trailing slash from apiUrl before building iframe src", async () => {
    const script = await getScript();
    expect(script).toContain('apiUrl.replace(/\\/$/,"")');
  });

  // --- Bubble button ---

  it("creates a button element for the bubble", async () => {
    const script = await getScript();
    expect(script).toContain('createElement("button")');
  });

  it("sets aria-label on bubble", async () => {
    const script = await getScript();
    expect(script).toContain('"aria-label","Open Atlas Chat"');
  });

  it("uses chat icon SVG (Lucide MessageCircle)", async () => {
    const script = await getScript();
    expect(script).toContain("<svg");
    expect(script).toContain("</svg>");
  });

  it("includes close icon SVG", async () => {
    const script = await getScript();
    // The close icon has two crossing paths (X shape)
    expect(script).toContain("18 6 6 18");
    expect(script).toContain("6 6 12 12");
  });

  it("applies entrance animation on bubble", async () => {
    const script = await getScript();
    expect(script).toContain("requestAnimationFrame");
    expect(script).toContain("atlas-wl-show");
  });

  // --- Open / Close ---

  it("toggles open state on bubble click", async () => {
    const script = await getScript();
    expect(script).toContain("setOpen(!isOpen)");
  });

  it("closes on Escape key", async () => {
    const script = await getScript();
    expect(script).toContain('"Escape"');
    expect(script).toContain("keydown");
  });

  it("toggles CSS class for open/close animation", async () => {
    const script = await getScript();
    expect(script).toContain("atlas-wl-open");
  });

  // --- postMessage bridge ---

  it("validates message origin against api URL", async () => {
    const script = await getScript();
    expect(script).toContain("e.origin!==origin");
  });

  it("handles atlas:ready message from widget", async () => {
    const script = await getScript();
    expect(script).toContain('"atlas:ready"');
    expect(script).toContain("isReady=true");
  });

  it("sends auth token to widget on atlas:ready", async () => {
    const script = await getScript();
    expect(script).toContain('{type:"auth",token:apiKey}');
  });

  it("handles atlas:open message from widget", async () => {
    const script = await getScript();
    expect(script).toContain('"atlas:open"');
    expect(script).toContain("setOpen(true)");
  });

  it("handles atlas:close message from widget", async () => {
    const script = await getScript();
    expect(script).toContain('"atlas:close"');
    expect(script).toContain("setOpen(false)");
  });

  it("forwards atlas:setTheme to widget iframe", async () => {
    const script = await getScript();
    expect(script).toContain('"atlas:setTheme"');
    expect(script).toContain('{type:"theme",value:theme}');
  });

  it("forwards atlas:setAuth to widget iframe", async () => {
    const script = await getScript();
    expect(script).toContain('"atlas:setAuth"');
    expect(script).toContain('{type:"auth",token:apiKey}');
  });

  it("validates setTheme value is light or dark", async () => {
    const script = await getScript();
    // The handler checks d.value==="light"||d.value==="dark"
    expect(script).toContain('d.value==="light"||d.value==="dark"');
  });

  it("validates setAuth token is a string", async () => {
    const script = await getScript();
    expect(script).toContain('typeof d.token==="string"');
  });

  it("sends postMessage to iframe with correct origin", async () => {
    const script = await getScript();
    expect(script).toContain("postMessage(msg,origin)");
  });

  it("warns when sending to widget before iframe is ready", async () => {
    const script = await getScript();
    expect(script).toContain("Widget iframe not ready, message dropped:");
  });

  // --- Security ---

  it("accepts host page API messages only from same window", async () => {
    const script = await getScript();
    // The public API listener must check e.source!==window (reject cross-origin)
    expect(script).toContain("e.source!==window)return");
  });

  it("checks origin for widget iframe messages", async () => {
    const script = await getScript();
    expect(script).toContain("e.origin!==origin)return");
  });

  // --- Error handling ---

  it("handles atlas:error messages from widget iframe", async () => {
    const script = await getScript();
    expect(script).toContain('"atlas:error"');
    expect(script).toContain("[Atlas] Widget error:");
  });

  it("warns on invalid setTheme value", async () => {
    const script = await getScript();
    expect(script).toContain("[Atlas] Invalid theme value:");
  });

  it("warns on invalid setAuth payload", async () => {
    const script = await getScript();
    expect(script).toContain("[Atlas] Invalid auth payload: token must be a string");
  });

  it("handles iframe load errors", async () => {
    const script = await getScript();
    expect(script).toContain("[Atlas] Failed to load widget iframe");
  });

  // --- Query param isolation ---

  it("ignores query parameters (static output)", async () => {
    const normal = await getScript();
    const res = await app.fetch(
      new Request("http://localhost/widget.js?theme=%3Cscript%3Ealert(1)%3C/script%3E"),
    );
    const withParams = await res.text();
    expect(normal).toBe(withParams);
  });

  // --- Syntax validation ---

  it("produces syntactically valid JavaScript", async () => {
    const script = await getScript();
    // Wrap in a function to avoid executing DOM APIs, but verify it parses
    expect(() => new Function(script)).not.toThrow();
  });

  // --- CSS / Styling ---

  it("injects scoped CSS styles", async () => {
    const script = await getScript();
    expect(script).toContain("atlas-wl-bubble");
    expect(script).toContain("atlas-wl-frame-wrap");
  });

  it("uses fixed positioning for bubble", async () => {
    const script = await getScript();
    expect(script).toContain("position:fixed");
  });

  it("uses high z-index to stay on top", async () => {
    const script = await getScript();
    expect(script).toContain("z-index:2147483646");
  });

  it("includes hover and active states for bubble", async () => {
    const script = await getScript();
    expect(script).toContain(".atlas-wl-bubble:hover");
    expect(script).toContain(".atlas-wl-bubble:active");
  });

  // --- Size check ---

  it("is under 5KB gzipped", async () => {
    const script = await getScript();
    const compressed = Bun.gzipSync(Buffer.from(script));
    expect(compressed.byteLength).toBeLessThan(5120);
  });

  // --- Idempotency ---

  it("returns identical content on multiple requests", async () => {
    const [a, b] = await Promise.all([getScript(), getScript()]);
    expect(a).toBe(b);
  });

  // --- Programmatic API (window.Atlas) ---

  it("exposes window.Atlas object with API methods", async () => {
    const script = await getScript();
    expect(script).toContain("window.Atlas={");
  });

  it("defines Atlas.open() method", async () => {
    const script = await getScript();
    expect(script).toContain("open:function()");
    // Opens the panel and notifies iframe
    expect(script).toContain('sendToWidget({type:"open"})');
  });

  it("defines Atlas.close() method", async () => {
    const script = await getScript();
    expect(script).toContain("close:function()");
    // Closes the panel and notifies iframe
    expect(script).toContain('sendToWidget({type:"close"})');
  });

  it("defines Atlas.toggle() method that sends resolved state", async () => {
    const script = await getScript();
    expect(script).toContain("toggle:function()");
    // Sends resolved open/close state, not "toggle", to avoid host/iframe desync
    expect(script).toContain('next?"open":"close"');
  });

  it("defines Atlas.ask() method that opens and sends question", async () => {
    const script = await getScript();
    expect(script).toContain("ask:function(question)");
    expect(script).toContain('{type:"atlas:ask",query:question}');
    // Guards against non-string arguments
    expect(script).toContain('[Atlas] ask() requires a string argument');
  });

  it("Atlas.ask() checks isReady before sending to iframe", async () => {
    const script = await getScript();
    // ask() now guards with isReady like open/close
    expect(script).toContain("if(isReady)sendToWidget({type:\"atlas:ask\"");
  });

  it("defines Atlas.destroy() method that removes DOM elements", async () => {
    const script = await getScript();
    expect(script).toContain("destroy:function()");
    // Removes bubble, wrap, and style from DOM
    expect(script).toContain("bubble.parentNode)bubble.parentNode.removeChild(bubble)");
    expect(script).toContain("wrap.parentNode)wrap.parentNode.removeChild(wrap)");
    expect(script).toContain("style.parentNode)style.parentNode.removeChild(style)");
  });

  it("destroy() removes message and keyboard listeners", async () => {
    const script = await getScript();
    expect(script).toContain('removeEventListener("message",onWidgetMessage)');
    expect(script).toContain('removeEventListener("message",onHostMessage)');
    expect(script).toContain('removeEventListener("keydown",onEscape)');
  });

  it("destroy() clears event listeners and deletes window.Atlas", async () => {
    const script = await getScript();
    expect(script).toContain("listeners={}");
    expect(script).toContain("delete window.Atlas");
  });

  it("destroy() sets destroyed flag to prevent further API calls", async () => {
    const script = await getScript();
    expect(script).toContain("destroyed=true");
    expect(script).toContain("if(destroyed)return");
  });

  it("defines Atlas.on() for programmatic event binding", async () => {
    const script = await getScript();
    expect(script).toContain("on:function(event,handler)");
    // Validates handler is a function with warning
    expect(script).toContain('[Atlas] on() handler must be a function');
  });

  it("Atlas.on() checks destroyed flag", async () => {
    const script = await getScript();
    // on() must guard against post-destroy registration
    const onMethod = script.slice(script.indexOf("on:function(event,handler)"));
    expect(onMethod).toContain("if(destroyed)return");
  });

  it("defines Atlas.setAuthToken() with validation warning", async () => {
    const script = await getScript();
    expect(script).toContain("setAuthToken:function(token)");
    expect(script).toContain('{type:"auth",token:apiKey}');
    expect(script).toContain("[Atlas] setAuthToken() requires a string token");
  });

  it("defines Atlas.setTheme() with validation warning", async () => {
    const script = await getScript();
    expect(script).toContain("setTheme:function(value)");
    expect(script).toContain('{type:"theme",value:value}');
    expect(script).toContain("[Atlas] Invalid theme value:");
  });

  // --- Pre-load command queue ---

  it("captures pre-load command queue from window.Atlas array", async () => {
    const script = await getScript();
    expect(script).toContain(
      "var q=window.Atlas&&Array.isArray(window.Atlas)?window.Atlas:[]",
    );
  });

  it("replays queued commands after API is initialized", async () => {
    const script = await getScript();
    expect(script).toContain("for(var i=0;i<q.length;i++)");
    expect(script).toContain("window.Atlas[cmd[0]].apply(null,cmd.slice(1))");
  });

  it("warns on invalid queued commands", async () => {
    const script = await getScript();
    expect(script).toContain("[Atlas] Invalid queued command at index");
    expect(script).toContain("[Atlas] Unknown queued method:");
  });

  it("wraps queued command replay in try-catch", async () => {
    const script = await getScript();
    expect(script).toContain("[Atlas] Queued command error:");
  });

  // --- Event system ---

  it("defines event emitter with listener registry", async () => {
    const script = await getScript();
    expect(script).toContain("var listeners={}");
    expect(script).toContain("function emit(ev,detail)");
  });

  it("maps event names to data-on-* attributes", async () => {
    const script = await getScript();
    expect(script).toContain('"data-on-open"');
    expect(script).toContain('"data-on-close"');
    expect(script).toContain('"data-on-query-complete"');
    expect(script).toContain('"data-on-error"');
  });

  it("reads data-on-* attributes for global function callbacks", async () => {
    const script = await getScript();
    // emit() reads the attribute value and looks up the global function
    expect(script).toContain("s.getAttribute(attr)");
    expect(script).toContain('typeof window[fn]==="function"');
  });

  it("calls data-on-* global function callbacks with error handling", async () => {
    const script = await getScript();
    expect(script).toContain("window[fn](detail)");
    expect(script).toContain("[Atlas] Callback error:");
  });

  it("warns when data-on-* references a non-existent global function", async () => {
    const script = await getScript();
    expect(script).toContain("[Atlas] Callback");
    expect(script).toContain("is not a function on window");
  });

  it("calls programmatic listeners registered via Atlas.on()", async () => {
    const script = await getScript();
    expect(script).toContain("arr[i](detail)");
    expect(script).toContain("[Atlas] Listener error:");
  });

  it("emits open event when widget opens", async () => {
    const script = await getScript();
    // setOpen(true) calls emit("open",{})
    expect(script).toContain('emit("open",{})');
  });

  it("emits close event when widget closes", async () => {
    const script = await getScript();
    // setOpen(false) calls emit("close",{})
    expect(script).toContain('emit("close",{})');
  });

  it("emits error event on atlas:error from widget", async () => {
    const script = await getScript();
    expect(script).toContain('emit("error",{code:d.code,message:d.message})');
  });

  it("emits queryComplete event on atlas:queryComplete from widget", async () => {
    const script = await getScript();
    expect(script).toContain('"atlas:queryComplete"');
    expect(script).toContain('emit("queryComplete",d.detail||{})');
  });

  it("guards against duplicate open/close state transitions", async () => {
    const script = await getScript();
    // setOpen returns early if isOpen===v (prevents duplicate events)
    expect(script).toContain("if(isOpen===v)return");
  });

  // --- Named handlers for cleanup ---

  it("uses named message handlers for cleanup on destroy", async () => {
    const script = await getScript();
    expect(script).toContain("function onWidgetMessage(e)");
    expect(script).toContain("function onHostMessage(e)");
    expect(script).toContain("function onEscape(e)");
  });
});

describe("GET /widget.d.ts", () => {
  it("returns 200 with text/plain content type", async () => {
    const res = await app.fetch(new Request("http://localhost/widget.d.ts"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("sets CORS header", async () => {
    const res = await app.fetch(new Request("http://localhost/widget.d.ts"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("sets cache-control header", async () => {
    const res = await app.fetch(new Request("http://localhost/widget.d.ts"));
    const cc = res.headers.get("cache-control");
    expect(cc).toContain("public");
    expect(cc).toContain("max-age=");
  });

  it("wraps declarations in declare global for module-context safety", async () => {
    const types = await getTypes();
    expect(types).toContain("export {};");
    expect(types).toContain("declare global {");
  });

  it("declares AtlasWidget interface with all API methods", async () => {
    const types = await getTypes();
    expect(types).toContain("interface AtlasWidget");
    expect(types).toContain("open(): void");
    expect(types).toContain("close(): void");
    expect(types).toContain("toggle(): void");
    expect(types).toContain("ask(question: string): void");
    expect(types).toContain("destroy(): void");
    expect(types).toContain("setAuthToken(token: string): void");
    expect(types).toContain('setTheme(theme: "light" | "dark"): void');
  });

  it("declares typed on() method with event map", async () => {
    const types = await getTypes();
    expect(types).toContain("interface AtlasWidgetEventMap");
    expect(types).toContain("on<K extends keyof AtlasWidgetEventMap>");
  });

  it("declares event types for open, close, queryComplete, error", async () => {
    const types = await getTypes();
    expect(types).toContain("open: Record<string, never>");
    expect(types).toContain("close: Record<string, never>");
    expect(types).toContain("queryComplete:");
    expect(types).toContain("error: { code?: string; message?: string }");
  });

  it("augments Window interface with Atlas property", async () => {
    const types = await getTypes();
    expect(types).toContain("interface Window");
    expect(types).toContain("Atlas?: AtlasWidget | Array<[string, ...unknown[]]>");
  });

  it("returns identical content on multiple requests", async () => {
    const [a, b] = await Promise.all([getTypes(), getTypes()]);
    expect(a).toBe(b);
  });
});
