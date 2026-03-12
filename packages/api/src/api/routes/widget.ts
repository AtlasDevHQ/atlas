/**
 * Widget host route — serves a self-contained HTML page for iframe embedding.
 *
 * Loaded by the script tag loader (#236) as an iframe target.
 * Renders the @useatlas/react AtlasChat component via CDN.
 *
 * Query params:
 *   theme    — "light" | "dark" | "system" (default: "system")
 *   apiUrl   — Atlas API base URL (default: current origin)
 *   position — "bottomRight" | "bottomLeft" | "inline" (default: "inline")
 *
 * postMessage API (from parent window):
 *   { type: "theme", value: "dark" | "light" }
 *   { type: "auth", token: string }
 *   { type: "toggle" }
 */

import { Hono } from "hono";

const widget = new Hono();

const VALID_THEMES = new Set(["light", "dark", "system"]);
const VALID_POSITIONS = new Set(["bottomRight", "bottomLeft", "inline"]);

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
<script>try{var t=localStorage.getItem("atlas-theme");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme:dark)").matches);if(d)document.documentElement.classList.add("dark")}catch(e){}</script>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body>
<div id="atlas-widget"></div>
<script id="atlas-config" type="application/json">${configJSON}</script>
<script type="module">
import{createElement}from"https://esm.sh/react@19";
import{createRoot}from"https://esm.sh/react-dom@19/client";
const{AtlasChat,setTheme}=await import("https://esm.sh/@useatlas/react?deps=react@19,react-dom@19");

const cfg=JSON.parse(document.getElementById("atlas-config").textContent);
const apiUrl=cfg.apiUrl||window.location.origin;
const el=document.getElementById("atlas-widget");
const root=createRoot(el);
let state={theme:cfg.theme,apiKey:"",visible:true};

function render(){
  if(!state.visible){el.dataset.hidden="";return}
  delete el.dataset.hidden;
  root.render(createElement(AtlasChat,{apiUrl,apiKey:state.apiKey||void 0,theme:state.theme}));
}

window.addEventListener("message",e=>{
  const d=e.data;
  if(!d||typeof d!=="object"||typeof d.type!=="string")return;
  switch(d.type){
    case"theme":
      if(d.value==="light"||d.value==="dark"){state={...state,theme:d.value};setTheme(d.value);render()}
      break;
    case"auth":
      if(typeof d.token==="string"){state={...state,apiKey:d.token};render()}
      break;
    case"toggle":
      state={...state,visible:!state.visible};render();
      break;
  }
});

render();
</script>
</body>
</html>`;
}

widget.get("/", (c) => {
  const rawTheme = c.req.query("theme") ?? "system";
  const rawApiUrl = c.req.query("apiUrl") ?? "";
  const rawPosition = c.req.query("position") ?? "inline";

  const theme = VALID_THEMES.has(rawTheme) ? rawTheme : "system";
  const position = VALID_POSITIONS.has(rawPosition) ? rawPosition : "inline";

  // Allow embedding as iframe from any origin
  c.header("Content-Security-Policy", "frame-ancestors *");
  c.header("Access-Control-Allow-Origin", "*");

  return c.html(buildWidgetHTML({ theme, apiUrl: rawApiUrl, position }));
});

export { widget };
