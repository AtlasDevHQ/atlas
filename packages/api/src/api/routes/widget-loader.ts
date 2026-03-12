/**
 * Widget loader route — serves widget.js, a self-contained IIFE that injects
 * a floating chat bubble and iframe overlay into any host page.
 *
 * GET /widget.js — returns the loader script with application/javascript content type.
 * The script reads data-* attributes from its own <script> tag for configuration.
 *
 * Intended usage:
 *   <script src="https://api.example.com/widget.js" data-api-url="https://api.example.com"></script>
 */

import { Hono } from "hono";

const widgetLoader = new Hono();

/**
 * Build the IIFE loader script. Inlined as a template literal so there's no
 * build step or static file dependency — the Hono route returns it directly.
 */
function buildLoaderScript(): string {
  // The IIFE is written as plain JS (no TS, no imports) so it runs in any browser.
  // Everything is inside the IIFE — no globals leak.
  return `(function(){
"use strict";
var s=document.currentScript;
if(!s){console.error("[Atlas] widget.js must be loaded via a <script> tag");return}

var apiUrl=s.getAttribute("data-api-url");
if(!apiUrl){console.error("[Atlas] data-api-url attribute is required");return}

var apiKey=s.getAttribute("data-api-key")||"";
var theme=s.getAttribute("data-theme")||"light";
if(theme!=="light"&&theme!=="dark")theme="light";
var position=s.getAttribute("data-position")||"bottom-right";
if(position!=="bottom-right"&&position!=="bottom-left")position="bottom-right";

var isRight=position==="bottom-right";
var isOpen=false;
var isReady=false;
var origin;
try{origin=new URL(apiUrl).origin}catch(e){console.error("[Atlas] Invalid data-api-url:",apiUrl);return}

/* ---- Styles ---- */
var style=document.createElement("style");
style.textContent=\`
.atlas-wl-bubble{
  position:fixed;bottom:20px;\${isRight?"right:20px":"left:20px"};
  width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;
  background:#18181b;color:#fff;
  box-shadow:0 4px 12px rgba(0,0,0,.15);
  z-index:2147483646;
  display:flex;align-items:center;justify-content:center;
  transition:transform .2s ease,opacity .2s ease,box-shadow .2s ease;
  transform:scale(0);opacity:0;
  padding:0;
}
.atlas-wl-bubble:hover{box-shadow:0 6px 20px rgba(0,0,0,.25);transform:scale(1.05)!important}
.atlas-wl-bubble:active{transform:scale(.95)!important}
.atlas-wl-bubble.atlas-wl-show{transform:scale(1);opacity:1}
.atlas-wl-bubble svg{width:24px;height:24px;transition:transform .2s ease}
.atlas-wl-frame-wrap{
  position:fixed;bottom:88px;\${isRight?"right:20px":"left:20px"};
  width:400px;height:600px;max-height:calc(100vh - 108px);max-width:calc(100vw - 40px);
  z-index:2147483646;
  border-radius:12px;overflow:hidden;
  box-shadow:0 8px 32px rgba(0,0,0,.16);
  transition:transform .3s cubic-bezier(.4,0,.2,1),opacity .3s cubic-bezier(.4,0,.2,1);
  transform:translateY(16px) scale(.96);opacity:0;pointer-events:none;
}
.atlas-wl-frame-wrap.atlas-wl-open{transform:translateY(0) scale(1);opacity:1;pointer-events:auto}
.atlas-wl-frame-wrap iframe{width:100%;height:100%;border:none;border-radius:12px}
\`;
document.head.appendChild(style);

/* ---- Chat icon (Lucide MessageCircle) ---- */
var chatSVG='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/></svg>';
/* ---- Close icon (Lucide X) ---- */
var closeSVG='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

/* ---- Bubble button ---- */
var bubble=document.createElement("button");
bubble.className="atlas-wl-bubble";
bubble.setAttribute("aria-label","Open Atlas Chat");
bubble.innerHTML=chatSVG;
document.body.appendChild(bubble);

/* Entrance animation */
requestAnimationFrame(function(){requestAnimationFrame(function(){bubble.classList.add("atlas-wl-show")})});

/* ---- Iframe container ---- */
var wrap=document.createElement("div");
wrap.className="atlas-wl-frame-wrap";

var iframe=document.createElement("iframe");
var iframeSrc=apiUrl.replace(/\\/$/,"")+"/widget?position=inline&theme="+encodeURIComponent(theme);
if(apiKey)iframeSrc+="&apiKey="+encodeURIComponent(apiKey);
iframe.src=iframeSrc;
iframe.setAttribute("title","Atlas Chat");
iframe.setAttribute("allow","clipboard-write");
wrap.appendChild(iframe);
document.body.appendChild(wrap);

/* ---- Open / Close ---- */
function setOpen(v){
  isOpen=v;
  if(isOpen){
    wrap.classList.add("atlas-wl-open");
    bubble.innerHTML=closeSVG;
    bubble.setAttribute("aria-label","Close Atlas Chat");
  }else{
    wrap.classList.remove("atlas-wl-open");
    bubble.innerHTML=chatSVG;
    bubble.setAttribute("aria-label","Open Atlas Chat");
  }
}

bubble.addEventListener("click",function(){
  setOpen(!isOpen);
  if(isReady&&iframe.contentWindow){
    iframe.contentWindow.postMessage({type:"toggle"},origin);
  }
});

/* Escape to close */
document.addEventListener("keydown",function(e){
  if(e.key==="Escape"&&isOpen)setOpen(false);
});

/* ---- postMessage bridge ---- */
function sendToWidget(msg){
  if(iframe.contentWindow)iframe.contentWindow.postMessage(msg,origin);
}

window.addEventListener("message",function(e){
  if(!e.origin||e.origin!==origin)return;
  var d=e.data;
  if(!d||typeof d!=="object"||typeof d.type!=="string")return;
  switch(d.type){
    case"atlas:ready":
      isReady=true;
      if(apiKey)sendToWidget({type:"auth",token:apiKey});
      break;
    case"atlas:open":setOpen(true);break;
    case"atlas:close":setOpen(false);break;
  }
});

/* ---- Public API via postMessage (Host → Widget forwarding) ---- */
window.addEventListener("message",function(e){
  if(e.source===window)return;
  var d=e.data;
  if(!d||typeof d!=="object"||typeof d.type!=="string")return;
  switch(d.type){
    case"atlas:setTheme":
      if(d.value==="light"||d.value==="dark"){
        theme=d.value;
        sendToWidget({type:"theme",value:theme});
      }
      break;
    case"atlas:setAuth":
      if(typeof d.token==="string"){
        apiKey=d.token;
        sendToWidget({type:"auth",token:apiKey});
      }
      break;
    case"atlas:open":setOpen(true);break;
    case"atlas:close":setOpen(false);break;
  }
});
})();`;
}

// Cache the built script — it's the same for every request.
const loaderScript = buildLoaderScript();

widgetLoader.get("/", (c) => {
  c.header("Content-Type", "application/javascript; charset=UTF-8");
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return c.body(loaderScript);
});

export { widgetLoader };
