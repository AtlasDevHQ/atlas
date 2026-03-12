import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost:3000" });

const DOM_GLOBALS = [
  "document", "navigator", "location", "history", "screen",
  "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement",
  "HTMLFormElement", "HTMLAnchorElement", "HTMLImageElement", "HTMLDivElement",
  "HTMLSpanElement", "HTMLTableElement", "HTMLPreElement", "HTMLHeadingElement",
  "HTMLParagraphElement", "HTMLUListElement", "HTMLOListElement", "HTMLLIElement",
  "HTMLQuoteElement", "HTMLTableRowElement", "HTMLTableCellElement",
  "HTMLTableSectionElement", "HTMLBRElement", "HTMLHRElement",
  "HTMLSelectElement", "HTMLOptionElement", "HTMLCanvasElement",
  "HTMLBodyElement", "HTMLHtmlElement", "HTMLStyleElement", "HTMLScriptElement",
  "HTMLLinkElement", "HTMLMetaElement", "HTMLLabelElement",
  "Element", "Node", "Text", "Comment", "Document", "DocumentFragment",
  "NodeList", "HTMLCollection", "NamedNodeMap",
  "DOMParser", "XMLSerializer", "Range", "Selection",
  "TreeWalker", "NodeIterator", "NodeFilter",
  "CSSStyleDeclaration", "CSSStyleSheet", "StyleSheet", "MediaQueryList",
  "DOMTokenList", "DOMRect", "DOMRectReadOnly",
  "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "InputEvent", "CustomEvent",
  "PointerEvent", "WheelEvent", "UIEvent", "ErrorEvent", "ProgressEvent",
  "AnimationEvent", "TransitionEvent", "ClipboardEvent",
  "MutationObserver", "MutationRecord", "IntersectionObserver", "ResizeObserver",
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
    } catch {
      // skip non-configurable globals
    }
  }
}

try { (globalThis as Record<string, unknown>).window = win; }
catch { /* skip */ }
try { (globalThis as Record<string, unknown>).self = win; }
catch { /* skip */ }
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(cb, 0) as unknown as number;
(globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => clearTimeout(id);
