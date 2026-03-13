/**
 * Contract tests for the postMessage bridge between the widget loader
 * (host page IIFE) and the widget iframe handler.
 *
 * These tests verify that message types and property names the loader
 * sends match what the widget handler expects. Without these, either
 * side can drift independently and both pass their own tests while
 * messages are silently dropped at runtime (see #324).
 */

import { describe, it, expect, mock } from "bun:test";
import { Hono } from "hono";
import * as realFs from "node:fs";

// --- Setup: import both routes ---

// Widget loader has no dependencies — import directly.
const { widgetLoader } = await import("../routes/widget-loader");

// Widget route reads bundle assets at import time — mock fs so
// tests don't require a prior `bun run build` in packages/react/.
const mockedFs = {
  ...realFs,
  existsSync: (path: string) => {
    if (path.endsWith("/widget.js") || path.endsWith("/widget.css"))
      return true;
    return realFs.existsSync(path);
  },
  readFileSync: (path: string, ...args: unknown[]) => {
    if (path.endsWith("/widget.js")) return "/* mock widget js */";
    if (path.endsWith("/widget.css")) return "/* mock widget css */";
    return (realFs.readFileSync as (...a: unknown[]) => unknown)(path, ...args);
  },
};
mock.module("node:fs", () => ({ ...mockedFs, default: mockedFs }));

const { widget } = await import("../routes/widget");

const app = new Hono();
app.route("/widget.js", widgetLoader);
app.route("/widget", widget);

async function getLoaderScript(): Promise<string> {
  const res = await app.fetch(new Request("http://localhost/widget.js"));
  return res.text();
}

async function getWidgetHtml(): Promise<string> {
  const res = await app.fetch(new Request("http://localhost/widget"));
  return res.text();
}

describe("widget postMessage contract", () => {
  it("ask: loader sends atlas:ask with query, widget handles atlas:ask reading d.query", async () => {
    const [script, html] = await Promise.all([
      getLoaderScript(),
      getWidgetHtml(),
    ]);

    // Sender: loader ask() sends {type:"atlas:ask",query:question}
    expect(script).toContain('{type:"atlas:ask",query:question}');

    // Receiver: widget handles case"atlas:ask" and reads d.query
    expect(html).toContain('case"atlas:ask"');
    expect(html).toContain("submitQuery(d.query)");
  });

  it("auth: loader sends auth with token, widget handles auth reading d.token", async () => {
    const [script, html] = await Promise.all([
      getLoaderScript(),
      getWidgetHtml(),
    ]);

    // Sender: loader sends {type:"auth",token:apiKey} on atlas:ready
    expect(script).toContain('{type:"auth",token:apiKey}');

    // Receiver: widget handles case"auth" and reads d.token
    expect(html).toContain('case"auth"');
    expect(html).toContain("d.token");
  });

  it("theme: loader sends theme with value, widget handles theme reading d.value", async () => {
    const [script, html] = await Promise.all([
      getLoaderScript(),
      getWidgetHtml(),
    ]);

    // Sender: loader setTheme() sends {type:"theme",value:value}
    expect(script).toContain('{type:"theme",value:value}');

    // Receiver: widget handles case"theme" and reads d.value
    expect(html).toContain('case"theme"');
    expect(html).toContain("d.value");
  });

  it("toggle: loader sends toggle, widget handles toggle", async () => {
    const [script, html] = await Promise.all([
      getLoaderScript(),
      getWidgetHtml(),
    ]);

    // Sender: bubble click sends {type:"toggle"} to iframe
    expect(script).toContain('{type:"toggle"}');

    // Receiver: widget handles case"toggle"
    expect(html).toContain('case"toggle"');
  });
});
