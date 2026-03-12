/**
 * Widget host route — serves a self-contained HTML page for iframe embedding.
 *
 * Loaded by the script tag loader (issue #236) as an iframe target.
 * Renders the @useatlas/react AtlasChat component via CDN.
 *
 * Query params:
 *   theme    — "light" | "dark" | "system" (default: "system")
 *   apiUrl   — Atlas API base URL, must be http(s) (default: "" → falls back
 *              to the iframe's window.location.origin at runtime)
 *   position — "bottomRight" | "bottomLeft" | "inline" (default: "inline")
 *              Applied as data-position on <body>; consumed by parent script loader.
 *
 * postMessage API (from parent window only — e.source === window.parent):
 *   { type: "theme", value: "dark" | "light" }  — "system" not supported via postMessage
 *   { type: "auth", token: string }              — passed as apiKey prop to AtlasChat
 *   { type: "toggle" }                           — show/hide the widget
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

function buildWidgetHTML(config: {
  theme: string;
  apiUrl: string;
  position: string;
}): string {
  // Escape < to \u003c to prevent XSS via </script> injection in the JSON blob
  const configJSON = JSON.stringify(config).replace(/</g, "\\u003c");

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
  }
});

render();
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

  const theme = VALID_THEMES.has(rawTheme) ? rawTheme : "system";
  const apiUrl = sanitizeApiUrl(rawApiUrl);
  const position = VALID_POSITIONS.has(rawPosition) ? rawPosition : "inline";

  // Allow embedding as iframe from any origin
  c.header("Content-Security-Policy", "frame-ancestors *");
  c.header("Access-Control-Allow-Origin", "*");

  return c.html(buildWidgetHTML({ theme, apiUrl, position }));
});

export { widget };
