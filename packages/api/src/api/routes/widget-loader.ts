/**
 * Widget loader route — serves widget.js, a self-contained IIFE that injects
 * a floating chat bubble and iframe overlay into any host page.
 *
 * GET /widget.js  — returns the loader script with application/javascript content type.
 * GET /widget.d.ts — returns TypeScript ambient declarations for window.Atlas.
 *
 * The script reads data-* attributes from its own <script> tag for configuration:
 *   data-api-url           (required) — base URL of the Atlas API
 *   data-api-key           (optional) — API key for auth
 *   data-theme             (optional, default "light") — "light" or "dark"
 *   data-position          (optional, default "bottom-right") — "bottom-right" or "bottom-left"
 *   data-on-open           (optional) — global function name called when widget opens
 *   data-on-close          (optional) — global function name called when widget closes
 *   data-on-query-complete (optional) — global function name called on query completion
 *   data-on-error          (optional) — global function name called on widget error
 *
 * Programmatic API (available on window.Atlas after script loads):
 *   Atlas.open()              — opens the widget panel
 *   Atlas.close()             — closes the widget panel
 *   Atlas.toggle()            — toggles open/close
 *   Atlas.ask(question)       — opens widget and sends a question
 *   Atlas.destroy()           — removes widget from DOM, cleans up listeners
 *   Atlas.on(event, handler)  — binds event listener
 *   Atlas.setAuthToken(token) — sends auth token to widget iframe
 *   Atlas.setTheme(theme)     — sets widget theme ('light' | 'dark')
 *
 * Pre-load command queue:
 *   window.Atlas = window.Atlas || [];
 *   Atlas.push(['open']);
 *   Atlas.push(['ask', 'How many users signed up today?']);
 *
 * Intended usage:
 *   <script src="https://api.example.com/widget.js"
 *     data-api-url="https://api.example.com"
 *     data-api-key="sk-..."
 *     data-theme="dark"
 *     data-position="bottom-left"
 *     data-on-open="onAtlasOpen"
 *     data-on-error="onAtlasError"></script>
 */

import { Hono } from "hono";

const widgetLoader = new Hono();
const widgetTypesLoader = new Hono();

/**
 * Build the IIFE loader script. Inlined as a template literal so there's no
 * build step or static file dependency — the Hono route returns it directly.
 */
function buildLoaderScript(): string {
  // The IIFE is written as plain JS (no TS, no imports) so it runs in any browser.
  // window.Atlas is the only JS global exposed. DOM elements and scoped CSS are injected into the host page.
  return `(function(){
"use strict";
var q=window.Atlas&&Array.isArray(window.Atlas)?window.Atlas:[];
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
var destroyed=false;
var origin;
try{var u=new URL(apiUrl);if(u.protocol!=="https:"&&u.protocol!=="http:"){console.error("[Atlas] data-api-url must use http or https");return}origin=u.origin}catch(e){console.error("[Atlas] Invalid data-api-url:",apiUrl);return}

/* ---- Event system ---- */
var listeners={};
var attrMap={open:"data-on-open",close:"data-on-close",queryComplete:"data-on-query-complete",error:"data-on-error"};
function emit(ev,detail){
  var attr=attrMap[ev];
  if(attr){var fn=s.getAttribute(attr);if(fn){if(typeof window[fn]==="function"){try{window[fn](detail)}catch(err){console.error("[Atlas] Callback error:",err)}}else{console.warn("[Atlas] Callback",fn,"is not a function on window")}}}
  var arr=listeners[ev];
  if(arr){for(var i=0;i<arr.length;i++){try{arr[i](detail)}catch(err){console.error("[Atlas] Listener error:",err)}}}
}

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
iframe.src=iframeSrc;
iframe.setAttribute("title","Atlas Chat");
iframe.setAttribute("allow","clipboard-write");
wrap.appendChild(iframe);
document.body.appendChild(wrap);

/* ---- Open / Close ---- */
function setOpen(v){
  if(isOpen===v)return;
  isOpen=v;
  if(isOpen){
    wrap.classList.add("atlas-wl-open");
    bubble.innerHTML=closeSVG;
    bubble.setAttribute("aria-label","Close Atlas Chat");
    emit("open",{});
  }else{
    wrap.classList.remove("atlas-wl-open");
    bubble.innerHTML=chatSVG;
    bubble.setAttribute("aria-label","Open Atlas Chat");
    emit("close",{});
  }
}

bubble.addEventListener("click",function(){
  setOpen(!isOpen);
  if(isReady&&iframe.contentWindow){
    iframe.contentWindow.postMessage({type:"toggle"},origin);
  }
});

/* ---- Named handlers for cleanup ---- */
function onEscape(e){
  if(e.key==="Escape"&&isOpen)setOpen(false);
}
document.addEventListener("keydown",onEscape);

/* ---- postMessage bridge ---- */
function sendToWidget(msg){
  if(iframe.contentWindow){iframe.contentWindow.postMessage(msg,origin)}
  else{console.warn("[Atlas] Widget iframe not ready, message dropped:",msg.type)}
}

/* Messages from the widget iframe (origin-checked) */
function onWidgetMessage(e){
  if(!e.origin||e.origin!==origin)return;
  var d=e.data;
  if(!d||typeof d!=="object"||typeof d.type!=="string")return;
  switch(d.type){
    case"atlas:ready":
      isReady=true;
      if(apiKey)sendToWidget({type:"auth",token:apiKey});
      break;
    case"atlas:error":
      console.error("[Atlas] Widget error:",d.code,d.message);
      emit("error",{code:d.code,message:d.message});
      break;
    case"atlas:queryComplete":
      emit("queryComplete",d.detail||{});
      break;
    case"atlas:open":setOpen(true);break;
    case"atlas:close":setOpen(false);break;
  }
}
window.addEventListener("message",onWidgetMessage);

/* Host page API — same-window messages only (e.source === window).
   Prefer window.Atlas.setTheme() / setAuthToken() instead. postMessage kept for backward compat. */
function onHostMessage(e){
  if(e.source!==window)return;
  var d=e.data;
  if(!d||typeof d!=="object"||typeof d.type!=="string")return;
  switch(d.type){
    case"atlas:setTheme":
      if(d.value==="light"||d.value==="dark"){
        theme=d.value;
        sendToWidget({type:"theme",value:theme});
      }else{
        console.warn("[Atlas] Invalid theme value:",d.value,"(expected 'light' or 'dark')");
      }
      break;
    case"atlas:setAuth":
      if(typeof d.token==="string"){
        apiKey=d.token;
        sendToWidget({type:"auth",token:apiKey});
      }else{
        console.warn("[Atlas] Invalid auth payload: token must be a string");
      }
      break;
    case"atlas:open":setOpen(true);break;
    case"atlas:close":setOpen(false);break;
  }
}
window.addEventListener("message",onHostMessage);

/* Iframe load error — fires if src is unreachable */
iframe.addEventListener("error",function(){
  console.error("[Atlas] Failed to load widget iframe");
});

/* ---- window.Atlas programmatic API ---- */
window.Atlas={
  open:function(){if(!destroyed){setOpen(true);if(isReady)sendToWidget({type:"open"})}},
  close:function(){if(!destroyed){setOpen(false);if(isReady)sendToWidget({type:"close"})}},
  toggle:function(){if(!destroyed){var next=!isOpen;setOpen(next);if(isReady)sendToWidget({type:next?"open":"close"})}},
  ask:function(question){if(destroyed)return;if(typeof question!=="string"){console.warn("[Atlas] ask() requires a string argument");return}setOpen(true);if(isReady)sendToWidget({type:"ask",question:question})},
  destroy:function(){
    if(destroyed)return;
    destroyed=true;
    if(bubble.parentNode)bubble.parentNode.removeChild(bubble);
    if(wrap.parentNode)wrap.parentNode.removeChild(wrap);
    if(style.parentNode)style.parentNode.removeChild(style);
    window.removeEventListener("message",onWidgetMessage);
    window.removeEventListener("message",onHostMessage);
    document.removeEventListener("keydown",onEscape);
    listeners={};
    delete window.Atlas;
  },
  on:function(event,handler){
    if(destroyed)return;
    if(typeof handler!=="function"){console.warn("[Atlas] on() handler must be a function");return}
    if(!listeners[event])listeners[event]=[];
    listeners[event].push(handler);
  },
  setAuthToken:function(token){
    if(destroyed)return;
    if(typeof token!=="string"){console.warn("[Atlas] setAuthToken() requires a string token");return}
    apiKey=token;sendToWidget({type:"auth",token:apiKey})
  },
  setTheme:function(value){
    if(destroyed)return;
    if(value!=="light"&&value!=="dark"){console.warn("[Atlas] Invalid theme value:",value,"(expected 'light' or 'dark')");return}
    theme=value;sendToWidget({type:"theme",value:value})
  }
};

/* Replay queued commands */
for(var i=0;i<q.length;i++){
  var cmd=q[i];
  if(!Array.isArray(cmd)||cmd.length===0){console.warn("[Atlas] Invalid queued command at index",i);continue}
  if(typeof window.Atlas[cmd[0]]!=="function"){console.warn("[Atlas] Unknown queued method:",cmd[0]);continue}
  try{window.Atlas[cmd[0]].apply(null,cmd.slice(1))}catch(err){console.error("[Atlas] Queued command error:",cmd[0],err)}
}
})();`;
}

/**
 * TypeScript ambient declarations for window.Atlas.
 * Served from GET /widget.d.ts for host page type safety.
 */
function buildTypeDeclarations(): string {
  return `export {};
declare global {
  interface AtlasWidgetEventMap {
    open: Record<string, never>;
    close: Record<string, never>;
    queryComplete: { sql?: string; rowCount?: number };
    error: { code?: string; message?: string };
  }

  interface AtlasWidget {
    /** Opens the widget panel */
    open(): void;
    /** Closes the widget panel */
    close(): void;
    /** Toggles the widget panel open/close */
    toggle(): void;
    /** Opens the widget and sends a question */
    ask(question: string): void;
    /** Removes widget from DOM, cleans up all listeners, and deletes window.Atlas */
    destroy(): void;
    /** Binds an event listener (events: 'open', 'close', 'queryComplete', 'error') */
    on<K extends keyof AtlasWidgetEventMap>(event: K, handler: (detail: AtlasWidgetEventMap[K]) => void): void;
    /** Sends an auth token to the widget iframe */
    setAuthToken(token: string): void;
    /** Sets the widget theme */
    setTheme(theme: "light" | "dark"): void;
  }

  interface Window {
    Atlas?: AtlasWidget | Array<[string, ...unknown[]]>;
  }
}
`;
}

// Cache the built outputs — they're the same for every request.
const loaderScript = buildLoaderScript();
const typeDeclarations = buildTypeDeclarations();

widgetLoader.get("/", (c) => {
  c.header("Content-Type", "application/javascript; charset=UTF-8");
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return c.body(loaderScript);
});

widgetTypesLoader.get("/", (c) => {
  c.header("Content-Type", "text/plain; charset=UTF-8");
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return c.body(typeDeclarations);
});

export { widgetLoader, widgetTypesLoader };
