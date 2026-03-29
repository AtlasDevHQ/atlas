import { GlobalWindow } from "happy-dom";

const win = new GlobalWindow({ url: "http://localhost:3000" });

// Copy DOM-specific globals from happy-dom to globalThis.
// We need to be selective — avoid overwriting JS builtins like Object, Symbol, etc.
// The full list ensures querySelector/querySelectorAll work correctly.
const DOM_GLOBALS = [
  // Core DOM
  "document", "navigator", "location", "history", "screen",
  // HTML Elements
  "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement",
  "HTMLFormElement", "HTMLAnchorElement", "HTMLImageElement", "HTMLDivElement",
  "HTMLSpanElement", "HTMLTableElement", "HTMLPreElement", "HTMLHeadingElement",
  "HTMLParagraphElement", "HTMLUListElement", "HTMLOListElement", "HTMLLIElement",
  "HTMLQuoteElement", "HTMLTableRowElement", "HTMLTableCellElement",
  "HTMLTableSectionElement", "HTMLBRElement", "HTMLHRElement",
  "HTMLSelectElement", "HTMLOptionElement", "HTMLCanvasElement",
  "HTMLBodyElement", "HTMLHtmlElement", "HTMLStyleElement", "HTMLScriptElement",
  "HTMLLinkElement", "HTMLMetaElement", "HTMLLabelElement",
  // Core DOM types
  "Element", "Node", "Text", "Comment", "Document", "DocumentFragment",
  "NodeList", "HTMLCollection", "NamedNodeMap",
  // DOM utilities
  "DOMParser", "XMLSerializer", "Range", "Selection",
  "TreeWalker", "NodeIterator", "NodeFilter",
  "CSSStyleDeclaration", "CSSStyleSheet", "StyleSheet", "MediaQueryList",
  "DOMTokenList", "DOMRect", "DOMRectReadOnly",
  // Events
  "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "InputEvent", "CustomEvent",
  "PointerEvent", "WheelEvent", "UIEvent", "ErrorEvent", "ProgressEvent",
  "AnimationEvent", "TransitionEvent", "ClipboardEvent",
  "MutationObserver", "MutationRecord", "IntersectionObserver", "ResizeObserver",
  // Web APIs
  "Headers", "Request", "Response", "URL", "URLSearchParams",
  "Blob", "File", "FileReader", "FormData", "FileList",
  "AbortController", "AbortSignal",
  "SVGElement", "SVGSVGElement",
  "Image", "getComputedStyle", "matchMedia",
  "DOMException",
  "XMLHttpRequest", "WebSocket",
  "Storage", "localStorage", "sessionStorage",
] as const;

for (const key of DOM_GLOBALS) {
  const val = (win as unknown as Record<string, unknown>)[key];
  if (val !== undefined) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
      if (descriptor && !descriptor.configurable) continue;
      (globalThis as Record<string, unknown>)[key] = val;
    } catch (err) {
      // The configurable check above handles expected non-configurable properties.
      // If we still get here, something unexpected happened — log it.
      console.warn(`[test-setup] Failed to assign global "${key}":`, err);
    }
  }
}

// Set window/self globals (avoid Object.assign which may trigger readonly errors)
try { (globalThis as Record<string, unknown>).window = win; }
catch (err) { console.warn("[test-setup] Failed to assign global 'window':", err); }
try { (globalThis as Record<string, unknown>).self = win; }
catch (err) { console.warn("[test-setup] Failed to assign global 'self':", err); }
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(cb, 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);

// Sanity check — fail fast if critical DOM globals weren't assigned
for (const key of ["document", "Element", "Node", "HTMLElement"] as const) {
  if (!(key in globalThis)) {
    throw new Error(`[test-setup] Critical DOM global "${key}" was not assigned. Tests cannot run.`);
  }
}
