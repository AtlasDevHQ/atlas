/**
 * Widget host route — serves a self-contained HTML page for iframe embedding.
 *
 * Loaded by the script tag loader (issue #236) as an iframe target.
 * Renders the @useatlas/react AtlasChat component from a self-hosted bundle
 * (no external CDN dependencies).
 *
 * Static assets:
 *   GET /widget/atlas-widget.js  — self-contained ESM bundle (React + AtlasChat)
 *   GET /widget/atlas-widget.css — pre-compiled Tailwind CSS for widget components
 *
 * Query params:
 *   theme        — "light" | "dark" | "system" (default: "system")
 *   apiUrl       — Atlas API base URL, must be http(s) (default: "" → falls back
 *                  to the iframe's window.location.origin at runtime)
 *   position     — "bottomRight" | "bottomLeft" | "inline" (default: "inline")
 *                  Applied as data-position on <body>; consumed by parent script loader.
 *   logo         — HTTPS URL to a custom logo image (sanitized to "" if missing/invalid;
 *                  the AtlasChat component's default SVG logo remains when no custom logo is set)
 *   accent       — hex color without # (e.g. "4f46e5"); sets --atlas-widget-accent CSS
 *                  custom property and overrides send button, input focus, and link colors
 *   welcome      — welcome message shown before first user message
 *   initialQuery — auto-sends this query on first open
 *   showBranding — "true" (default) or "false"; hides "Powered by Atlas" badge when "false"
 *   starterPrompts — JSON-encoded array of strings (URL-encoded). When supplied,
 *                    overrides the adaptive starter-prompt list and the widget
 *                    skips the /api/v1/starter-prompts call entirely. Invalid
 *                    or oversized values are dropped silently.
 *
 * postMessage API (from parent window only — e.source === window.parent):
 *   { type: "theme", value: "dark" | "light" }     — "system" not supported via postMessage
 *   { type: "auth", token: string }                 — passed as apiKey prop to AtlasChat
 *   { type: "toggle" }                              — show/hide the widget
 *   { type: "atlas:setBranding", logo?, accent?, welcome? } — update branding at runtime
 *                                                            (use atlas:ask to send queries)
 *   { type: "atlas:ask", query: string }            — programmatically send a query
 *
 * Widget → parent messages:
 *   { type: "atlas:ready" }                                — widget loaded successfully
 *   { type: "atlas:error", code: string, message: string } — load/render/runtime error
 *
 * Messages with unknown types or invalid shapes are silently ignored.
 *
 * DOM contract — the inline script uses these stable data attributes from
 * @useatlas/react components (issue #256):
 *   [data-atlas-logo]     — logo element
 *   [data-atlas-messages] — message list container
 *   [data-atlas-input]    — chat text input
 *   [data-atlas-form]     — chat submit form
 */

import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@atlas/api/lib/logger";

const widget = new Hono();
const log = createLogger("widget");

const VALID_THEMES = new Set(["light", "dark", "system"]);
const VALID_POSITIONS = new Set(["bottomRight", "bottomLeft", "inline"]);
const HEX_COLOR_RE = /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

// ---------------------------------------------------------------------------
// Widget bundle assets — loaded once at module init from @useatlas/react dist.
// Restart the API server after rebuilding @useatlas/react to pick up changes.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadWidgetAsset(filename: string): string | null {
  const candidates = [
    // Monorepo layout: packages/api/src/api/routes/ → packages/react/dist/
    resolve(__dirname, "../../../../react/dist", filename),
    // npm-installed: root node_modules/@useatlas/react/dist/
    resolve(__dirname, "../../../../../node_modules/@useatlas/react/dist", filename),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, "utf8");
    } catch (err) {
      log.warn(
        { path: p, err: err instanceof Error ? err.message : String(err) },
        `Failed to read widget asset ${filename}`,
      );
    }
  }
  return null;
}

const WIDGET_JS = loadWidgetAsset("widget.js");
const WIDGET_CSS = loadWidgetAsset("widget.css");

if (!WIDGET_JS || !WIDGET_CSS) {
  log.warn(
    { hasJS: !!WIDGET_JS, hasCSS: !!WIDGET_CSS },
    "Widget bundle assets not found — /widget will return 503. " +
      "Run `bun run build` in packages/react/ to generate them.",
  );
}

// ---------------------------------------------------------------------------
// Sanitization helpers
// ---------------------------------------------------------------------------

/** Reject non-HTTP(S) URLs to prevent open redirect / API traffic exfiltration. */
function sanitizeApiUrl(raw: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return raw;
  } catch {
    return "";
  }
}

/** Logo URL must be HTTPS to prevent mixed content and XSS via javascript: / data: URIs. */
function sanitizeLogoUrl(raw: string): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    return raw;
  } catch {
    return "";
  }
}

/** Accent must be a valid 3- or 6-digit hex color (no #). */
function sanitizeAccent(raw: string): string {
  if (!raw) return "";
  return HEX_COLOR_RE.test(raw) ? raw : "";
}

/**
 * Sentinel-bearing return type for {@link sanitizeStarterPrompts}.
 *
 * - `null` — no override was supplied (or the supplied value couldn't be
 *   used). The widget falls back to `/api/v1/starter-prompts`.
 * - `string[]` — embedder opted in to overrides. The widget renders this
 *   list (even if empty) and **does not** call `/api/v1/starter-prompts`.
 *
 * The `null` vs `[]` distinction is the privacy boundary; callers must
 * preserve it across every transformation.
 */
type StarterPromptsOverride = string[] | null;

/**
 * Parse the `starterPrompts` query param into a clean string array.
 *
 * Returns `null` when the override is **absent, oversized, or fails to
 * parse as a JSON array**. A valid JSON array — even one that filters
 * down to zero usable entries — returns `[]`. The widget treats `null`
 * as "fetch from API" and any non-null array (including `[]`) as
 * "skip fetch".
 *
 * Failure mode: a malformed override falls back to `null`, which **does**
 * trigger the user-identifying API call. This is intentional for embedder
 * compatibility but means an embedder can lose their privacy guarantee
 * silently. Every fallback path therefore logs a warning so operators can
 * detect a misconfigured embedder before users notice.
 */
function sanitizeStarterPrompts(raw: string): StarterPromptsOverride {
  if (!raw) return null;
  // Cap raw length to prevent oversized HTML responses from a malicious
  // embedder / open-redirect chain. ~32 prompts × 200 chars ≈ 6.4KB upper
  // bound; the per-string slice below enforces the rest.
  if (raw.length > 8 * 1024) {
    console.warn(
      `[Atlas] starterPrompts query param exceeds 8KB (${raw.length} bytes); dropping override — widget will fetch the adaptive list instead`,
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      "[Atlas] starterPrompts query param is not valid JSON; dropping override:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!Array.isArray(parsed)) {
    console.warn(
      "[Atlas] starterPrompts query param parsed to non-array; expected JSON array of strings",
    );
    return null;
  }
  const cleaned: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    cleaned.push(trimmed.slice(0, 500));
    if (cleaned.length >= 32) break;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Widget HTML builder
// ---------------------------------------------------------------------------

function buildWidgetHTML(config: {
  theme: string;
  apiUrl: string;
  position: string;
  logo: string;
  accent: string;
  welcome: string;
  initialQuery: string;
  showBranding: boolean;
  /** See {@link StarterPromptsOverride}: `null` triggers the API fetch; any array (including `[]`) suppresses it. */
  starterPrompts: StarterPromptsOverride;
}): string {
  // Escape < to \u003c to prevent XSS via </script> injection in the JSON blob
  const configJSON = JSON.stringify(config).replace(/</g, "\\u003c");

  // Server-side accent CSS — only emitted when accent is a validated hex value.
  // Keep in sync with applyAccent() which duplicates these rules for runtime setBranding updates.
  const accentCSS = config.accent
    ? `
.atlas-accent{--atlas-widget-accent:#${config.accent}}
.atlas-accent button[type="submit"]{background-color:#${config.accent}!important}
.atlas-accent button[type="submit"]:hover{filter:brightness(1.1)}
.atlas-accent input:focus{border-color:#${config.accent}!important}
.atlas-accent a{color:#${config.accent}!important}`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Atlas</title>
<link rel="stylesheet" href="widget/atlas-widget.css">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;width:100%;overflow:hidden;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
body{background:#fff;color:#09090b}
.dark body{background:#09090b;color:#fafafa}
#atlas-widget{height:100%;width:100%}
#atlas-widget[data-hidden]{display:none}
.atlas-root{--radius:0.625rem;--background:oklch(1 0 0);--foreground:oklch(0.145 0 0);--card:oklch(1 0 0);--card-foreground:oklch(0.145 0 0);--popover:oklch(1 0 0);--popover-foreground:oklch(0.145 0 0);--primary:oklch(0.205 0 0);--primary-foreground:oklch(0.985 0 0);--secondary:oklch(0.97 0 0);--secondary-foreground:oklch(0.205 0 0);--muted:oklch(0.97 0 0);--muted-foreground:oklch(0.556 0 0);--accent:oklch(0.97 0 0);--accent-foreground:oklch(0.205 0 0);--destructive:oklch(0.577 0.245 27.325);--destructive-foreground:oklch(0.577 0.245 27.325);--border:oklch(0.922 0 0);--input:oklch(0.922 0 0);--ring:oklch(0.708 0 0);--atlas-brand:oklch(0.759 0.148 167.71)}
.dark .atlas-root{--background:oklch(0.145 0 0);--foreground:oklch(0.985 0 0);--card:oklch(0.145 0 0);--card-foreground:oklch(0.985 0 0);--popover:oklch(0.145 0 0);--popover-foreground:oklch(0.985 0 0);--primary:oklch(0.985 0 0);--primary-foreground:oklch(0.205 0 0);--secondary:oklch(0.269 0 0);--secondary-foreground:oklch(0.985 0 0);--muted:oklch(0.269 0 0);--muted-foreground:oklch(0.708 0 0);--accent:oklch(0.269 0 0);--accent-foreground:oklch(0.985 0 0);--destructive:oklch(0.396 0.141 25.723);--destructive-foreground:oklch(0.637 0.237 25.331);--border:oklch(0.269 0 0);--input:oklch(0.269 0 0);--ring:oklch(0.439 0 0)}
.atlas-welcome-msg{max-width:90%;margin-bottom:0.5rem}
.atlas-welcome-inner{border-radius:0.75rem;background:#f4f4f5;padding:0.75rem 1rem;font-size:0.875rem;color:#52525b}
.dark .atlas-welcome-inner{background:#27272a;color:#a1a1aa}
.atlas-custom-logo{height:1.75rem;width:1.75rem;object-fit:contain;flex-shrink:0}${accentCSS}
</style>
<script>
window.onerror=function(m){console.error("[Atlas Widget]",m);try{window.parent.postMessage({type:"atlas:error",code:"UNCAUGHT",message:String(m)},"*")}catch(x){console.warn("[Atlas Widget] Could not notify parent:",x)}};
window.addEventListener("unhandledrejection",function(e){console.error("[Atlas Widget]",e.reason);try{window.parent.postMessage({type:"atlas:error",code:"UNHANDLED_REJECTION",message:String(e.reason)},"*")}catch(x){console.warn("[Atlas Widget] Could not notify parent:",x)}});
</script>
<script>try{var t=localStorage.getItem("atlas-theme");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){console.warn("[Atlas Widget] Could not read theme:",e.message)}</script>
</head>
<body data-position="${config.position}">
<div id="atlas-widget"></div>
<script id="atlas-config" type="application/json">${configJSON}</script>
<script type="module" src="widget/atlas-widget.js"></script>
<script type="module">
try{
if(typeof AtlasWidget==="undefined")throw new Error("Widget bundle did not load — atlas-widget.js may have failed to fetch or execute");
const{createElement,Component,createRoot,AtlasChat,setTheme}=AtlasWidget;

const configEl=document.getElementById("atlas-config");
if(!configEl)throw new Error("Config element not found");
const cfg=JSON.parse(configEl.textContent??"{}");
const apiUrl=cfg.apiUrl||window.location.origin;
const el=document.getElementById("atlas-widget");
const root=createRoot(el);
let state={theme:cfg.theme,apiKey:"",visible:true};
let initialQuerySent=false;

const HEX_RE=/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

class EB extends Component{
  constructor(p){super(p);this.state={error:null}}
  static getDerivedStateFromError(e){return{error:e}}
  componentDidCatch(e){
    console.error("[Atlas Widget] Render error:",e);
    try{window.parent.postMessage({type:"atlas:error",code:"RENDER_FAILED",message:e.message},"*")}catch(x){console.warn("[Atlas Widget] Could not notify parent:",x)}
  }
  render(){
    if(this.state.error)return createElement("div",{style:{padding:"2rem",textAlign:"center",color:"#888",fontFamily:"system-ui"}},
      createElement("p",null,"Unable to load Atlas Chat."),
      createElement("p",{style:{fontSize:"0.875rem",marginTop:"0.5rem"}},"Try refreshing the page."));
    return this.props.children;
  }
}

function render(){
  if(!state.visible){el.dataset.hidden="";return}
  delete el.dataset.hidden;
  // cfg.starterPrompts is null when no override was supplied — pass undefined
  // to the component so it falls back to fetching /api/v1/starter-prompts.
  // A non-null array (even empty) means "skip the fetch".
  const starterPromptsProp=Array.isArray(cfg.starterPrompts)?cfg.starterPrompts:void 0;
  root.render(createElement(EB,null,createElement(AtlasChat,{apiUrl,apiKey:state.apiKey||void 0,theme:state.theme,showBranding:cfg.showBranding!==false,starterPrompts:starterPromptsProp})));
}

/** Replace the default Atlas logo element with a custom <img>.
 *  Uses the stable data-atlas-logo attribute from @useatlas/react. */
function applyLogo(src){
  if(!src)return;
  const logo=el.querySelector("[data-atlas-logo]");
  if(!logo){console.warn("[Atlas Widget] Could not find logo element to replace");return}
  const img=document.createElement("img");
  img.src=src;img.alt="Logo";img.className="atlas-custom-logo";
  img.onerror=function(){console.warn("[Atlas Widget] Custom logo failed to load:",src);img.style.display="none"};
  logo.replaceWith(img);
}

/** Apply accent color via CSS class on the widget container. */
function applyAccent(hex){
  if(!hex||!HEX_RE.test(hex))return;
  el.classList.add("atlas-accent");
  el.style.setProperty("--atlas-widget-accent","#"+hex);
  // Inject/update dynamic accent style for runtime changes
  let style=document.getElementById("atlas-accent-style");
  if(!style){style=document.createElement("style");style.id="atlas-accent-style";document.head.appendChild(style)}
  style.textContent='.atlas-accent button[type="submit"]{background-color:#'+hex+'!important}.atlas-accent button[type="submit"]:hover{filter:brightness(1.1)}.atlas-accent input:focus{border-color:#'+hex+'!important}.atlas-accent a{color:#'+hex+'!important}';
}

/** Insert a welcome message above the messages area.
 *  Uses the stable data-atlas-messages attribute from @useatlas/react. */
function applyWelcome(text){
  // Remove any existing welcome
  const old=document.getElementById("atlas-welcome");
  if(old)old.remove();
  if(!text)return;
  const wrapper=document.createElement("div");
  wrapper.id="atlas-welcome";wrapper.className="atlas-welcome-msg";
  const inner=document.createElement("div");
  inner.className="atlas-welcome-inner";inner.textContent=text;
  wrapper.appendChild(inner);
  const messages=el.querySelector("[data-atlas-messages]");
  if(messages){
    messages.prepend(wrapper);
  }else{
    console.warn("[Atlas Widget] Could not find messages area to insert welcome message");
  }
}

/** Programmatically submit a query. Uses the native HTMLInputElement value setter
 *  to bypass React's synthetic value tracking — setting .value directly on a
 *  controlled input does not trigger React state updates.
 *  Uses stable data-atlas-input and data-atlas-form attributes. */
function submitQuery(query){
  if(!query)return;
  const input=el.querySelector("[data-atlas-input]");
  if(!input){console.warn("[Atlas Widget] Cannot submit query: input element not found");return}
  const desc=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
  if(!desc||!desc.set){console.warn("[Atlas Widget] Cannot submit query: input value setter unavailable");return}
  desc.set.call(input,query);
  input.dispatchEvent(new Event("input",{bubbles:true}));
  requestAnimationFrame(function(){
    const form=el.querySelector("[data-atlas-form]");
    if(!form){console.warn("[Atlas Widget] Cannot submit query: form element not found");return}
    form.requestSubmit();
  });
}

window.addEventListener("message",e=>{
  if(e.source!==window.parent)return;
  const d=e.data;
  if(!d||typeof d!=="object"||typeof d.type!=="string")return;
  switch(d.type){
    case"theme":
      if(d.value!=="light"&&d.value!=="dark"){console.warn("[Atlas Widget] Invalid theme:",d.value);break}
      state={...state,theme:d.value};setTheme(d.value);render();
      break;
    case"auth":
      if(typeof d.token!=="string"){console.warn("[Atlas Widget] Invalid auth: token must be string");break}
      state={...state,apiKey:d.token};render();
      break;
    case"toggle":
      state={...state,visible:!state.visible};render();
      break;
    case"atlas:setBranding":{
      if(typeof d.logo==="string"){
        try{const u=new URL(d.logo);if(u.protocol==="https:"){applyLogo(d.logo)}else{console.warn("[Atlas Widget] Logo URL rejected: must use HTTPS, got",u.protocol)}}catch(urlErr){console.warn("[Atlas Widget] Invalid logo URL:",d.logo)}
      }
      if(typeof d.accent==="string")applyAccent(d.accent);
      if(typeof d.welcome==="string")applyWelcome(d.welcome);
      break;
    }
    case"atlas:ask":
      if(typeof d.query==="string"&&d.query.trim())submitQuery(d.query);
      break;
  }
});

render();

/** Wait for the AtlasChat component to render, then invoke callback.
 *  Polls for [data-atlas-input] up to 16 times at 300ms intervals (~4.8s). */
function waitForReady(cb,attempts){
  attempts=attempts||0;
  const input=el.querySelector("[data-atlas-input]");
  if(input){cb();return}
  if(attempts>15){console.warn("[Atlas Widget] Timed out waiting for chat UI to render — some branding may not apply");cb();return}
  setTimeout(function(){waitForReady(cb,attempts+1)},300);
}

// Apply branding after AtlasChat renders
waitForReady(function(){
  if(cfg.logo)applyLogo(cfg.logo);
  if(cfg.accent)applyAccent(cfg.accent);
  if(cfg.welcome)applyWelcome(cfg.welcome);
  // Auto-send initial query on first open
  if(cfg.initialQuery&&!initialQuerySent){
    initialQuerySent=true;
    submitQuery(cfg.initialQuery);
  }
});

window.parent.postMessage({type:"atlas:ready"},"*");
}catch(err){
console.error("[Atlas Widget] Failed to load:",err);
const el=document.getElementById("atlas-widget");
if(el)el.innerHTML='<div style="padding:2rem;text-align:center;color:#888;font-family:system-ui"><p>Unable to load Atlas Chat.</p><p style="font-size:0.875rem;margin-top:0.5rem">Check your network connection or try refreshing.</p></div>';
try{window.parent.postMessage({type:"atlas:error",code:"LOAD_FAILED",message:String(err.message||err)},"*")}catch(x){console.warn("[Atlas Widget] Could not notify parent:",x)}
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Serve the self-contained widget JS bundle. */
widget.get("/atlas-widget.js", (c) => {
  if (!WIDGET_JS) {
    return c.text(
      "Widget JS bundle not built. Run `bun run build` in packages/react/.",
      404,
    );
  }
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=86400");
  c.header("Access-Control-Allow-Origin", "*");
  return c.body(WIDGET_JS);
});

/** Serve the pre-compiled widget CSS (Tailwind utilities). */
widget.get("/atlas-widget.css", (c) => {
  if (!WIDGET_CSS) {
    return c.text(
      "Widget CSS not built. Run `bun run build` in packages/react/.",
      404,
    );
  }
  c.header("Content-Type", "text/css; charset=utf-8");
  c.header("Cache-Control", "public, max-age=86400");
  c.header("Access-Control-Allow-Origin", "*");
  return c.body(WIDGET_CSS);
});

/** Serve the widget HTML page. Returns 503 if widget bundle is not built. */
widget.get("/", (c) => {
  if (!WIDGET_JS) {
    c.header("Content-Security-Policy", "frame-ancestors *");
    c.header("Access-Control-Allow-Origin", "*");
    return c.html(
      `<!DOCTYPE html><html><body style="padding:2rem;text-align:center;color:#888;font-family:system-ui">` +
        `<p>Widget bundle not built.</p>` +
        `<p style="font-size:0.875rem;margin-top:0.5rem">Run <code>bun run build</code> in packages/react/.</p>` +
        `</body></html>`,
      503,
    );
  }

  const rawTheme = c.req.query("theme") ?? "system";
  const rawApiUrl = c.req.query("apiUrl") ?? "";
  const rawPosition = c.req.query("position") ?? "inline";
  const rawLogo = c.req.query("logo") ?? "";
  const rawAccent = c.req.query("accent") ?? "";
  const rawWelcome = c.req.query("welcome") ?? "";
  const rawInitialQuery = c.req.query("initialQuery") ?? "";
  const rawShowBranding = c.req.query("showBranding") ?? "true";
  const rawStarterPrompts = c.req.query("starterPrompts") ?? "";

  const theme = VALID_THEMES.has(rawTheme) ? rawTheme : "system";
  const apiUrl = sanitizeApiUrl(rawApiUrl);
  const position = VALID_POSITIONS.has(rawPosition) ? rawPosition : "inline";
  const logo = sanitizeLogoUrl(rawLogo);
  const accent = sanitizeAccent(rawAccent);
  // welcome and initialQuery are plain text — sanitized by JSON.stringify + < escaping.
  // Length-limited to prevent oversized HTML responses.
  const welcome = rawWelcome.slice(0, 500);
  const initialQuery = rawInitialQuery.slice(0, 500);
  const showBranding = rawShowBranding !== "false";
  const starterPrompts = sanitizeStarterPrompts(rawStarterPrompts);

  // Allow embedding as iframe from any origin
  c.header("Content-Security-Policy", "frame-ancestors *");
  c.header("Access-Control-Allow-Origin", "*");

  return c.html(
    buildWidgetHTML({ theme, apiUrl, position, logo, accent, welcome, initialQuery, showBranding, starterPrompts }),
  );
});

export { widget, sanitizeLogoUrl, sanitizeAccent, sanitizeStarterPrompts };
