/**
 * Widget host route — serves a self-contained HTML page for iframe embedding.
 *
 * Loaded by the script tag loader (issue #236) as an iframe target.
 * Renders the @useatlas/react AtlasChat component via CDN.
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
 */

import { Hono } from "hono";

const widget = new Hono();

const VALID_THEMES = new Set(["light", "dark", "system"]);
const VALID_POSITIONS = new Set(["bottomRight", "bottomLeft", "inline"]);
const HEX_COLOR_RE = /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

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

function buildWidgetHTML(config: {
  theme: string;
  apiUrl: string;
  position: string;
  logo: string;
  accent: string;
  welcome: string;
  initialQuery: string;
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
window.onerror=function(m){console.error("[Atlas Widget]",m);try{window.parent.postMessage({type:"atlas:error",code:"UNCAUGHT",message:String(m)},"*")}catch(x){}};
window.addEventListener("unhandledrejection",function(e){console.error("[Atlas Widget]",e.reason);try{window.parent.postMessage({type:"atlas:error",code:"UNHANDLED_REJECTION",message:String(e.reason)},"*")}catch(x){}});
</script>
<script>try{var t=localStorage.getItem("atlas-theme");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){console.warn("[Atlas Widget] Could not read theme:",e.message)}</script>
<!-- Tailwind CSS Play CDN — generates utility classes at runtime for CDN-loaded
     @useatlas/react components. Temporary measure; v3 Play CDN is not intended
     for production. TODO: replace with pre-compiled widget CSS bundle. -->
<script src="https://cdn.tailwindcss.com" onerror="console.warn('[Atlas Widget] Tailwind CDN unavailable — styling may be degraded')"></script>
</head>
<body data-position="${config.position}">
<div id="atlas-widget"></div>
<script id="atlas-config" type="application/json">${configJSON}</script>
<script type="module">
try{
const[{createElement,Component},{createRoot},{AtlasChat,setTheme}]=await Promise.all([
  import("https://esm.sh/react@19"),
  import("https://esm.sh/react-dom@19/client"),
  import("https://esm.sh/@useatlas/react?deps=react@19,react-dom@19"),
]);

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
    try{window.parent.postMessage({type:"atlas:error",code:"RENDER_FAILED",message:e.message},"*")}catch(x){}
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
  root.render(createElement(EB,null,createElement(AtlasChat,{apiUrl,apiKey:state.apiKey||void 0,theme:state.theme})));
}

/** Replace the default Atlas SVG logo with a custom <img>.
 *  Finds the logo by viewBox="0 0 256 256" — must be updated if @useatlas/react changes its header SVG. */
function applyLogo(src){
  if(!src)return;
  const svg=el.querySelector("svg[viewBox='0 0 256 256']");
  if(!svg){console.warn("[Atlas Widget] Could not find default logo SVG to replace");return}
  const img=document.createElement("img");
  img.src=src;img.alt="Logo";img.className="atlas-custom-logo";
  img.onerror=function(){console.warn("[Atlas Widget] Custom logo failed to load:",src);img.style.display="none"};
  svg.replaceWith(img);
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

/** Insert a welcome message above the messages area. */
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
  // Insert before the messages area — targets Radix ScrollArea internal attribute;
  // must be updated if Radix changes this data attribute.
  const scrollArea=el.querySelector("[data-radix-scroll-area-viewport]");
  if(scrollArea&&scrollArea.firstChild){
    scrollArea.firstChild.prepend(wrapper);
  }else{
    console.warn("[Atlas Widget] Could not find scroll area to insert welcome message");
  }
}

/** Programmatically submit a query. Uses the native HTMLInputElement value setter
 *  to bypass React's synthetic value tracking — setting .value directly on a
 *  controlled input does not trigger React state updates. */
function submitQuery(query){
  if(!query)return;
  const input=el.querySelector("input");
  if(!input){console.warn("[Atlas Widget] Cannot submit query: input element not found");return}
  const desc=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
  if(!desc||!desc.set){console.warn("[Atlas Widget] Cannot submit query: input value setter unavailable");return}
  desc.set.call(input,query);
  input.dispatchEvent(new Event("input",{bubbles:true}));
  requestAnimationFrame(function(){
    const form=input.closest("form");
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
 *  Polls for the input element up to maxAttempts times (300ms apart). */
function waitForReady(cb,attempts){
  attempts=attempts||0;
  const input=el.querySelector("input");
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
try{window.parent.postMessage({type:"atlas:error",code:"LOAD_FAILED",message:String(err.message||err)},"*")}catch(x){}
}
</script>
</body>
</html>`;
}

widget.get("/", (c) => {
  const rawTheme = c.req.query("theme") ?? "system";
  const rawApiUrl = c.req.query("apiUrl") ?? "";
  const rawPosition = c.req.query("position") ?? "inline";
  const rawLogo = c.req.query("logo") ?? "";
  const rawAccent = c.req.query("accent") ?? "";
  const rawWelcome = c.req.query("welcome") ?? "";
  const rawInitialQuery = c.req.query("initialQuery") ?? "";

  const theme = VALID_THEMES.has(rawTheme) ? rawTheme : "system";
  const apiUrl = sanitizeApiUrl(rawApiUrl);
  const position = VALID_POSITIONS.has(rawPosition) ? rawPosition : "inline";
  const logo = sanitizeLogoUrl(rawLogo);
  const accent = sanitizeAccent(rawAccent);
  // welcome and initialQuery are plain text — sanitized by JSON.stringify + < escaping.
  // Length-limited to prevent oversized HTML responses.
  const welcome = rawWelcome.slice(0, 500);
  const initialQuery = rawInitialQuery.slice(0, 500);

  // Allow embedding as iframe from any origin
  c.header("Content-Security-Policy", "frame-ancestors *");
  c.header("Access-Control-Allow-Origin", "*");

  return c.html(
    buildWidgetHTML({ theme, apiUrl, position, logo, accent, welcome, initialQuery }),
  );
});

export { widget, sanitizeLogoUrl, sanitizeAccent };
