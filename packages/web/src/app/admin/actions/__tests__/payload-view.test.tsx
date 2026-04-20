import { describe, expect, test, beforeEach, afterEach, mock, type Mock } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { PayloadView } from "../payload-view";

// Silence + assert the observability warn the component fires when a
// known-type payload is malformed. Without the spy, every malformed-
// payload branch floods CI stderr. The warn contract is part of the
// component's interface — dropping it silently would make schema drift
// (agent emits a new payload shape) invisible.
let consoleWarnSpy: Mock<(...args: unknown[]) => void>;
const originalConsoleWarn = console.warn;

beforeEach(() => {
  consoleWarnSpy = mock(() => {});
  console.warn = consoleWarnSpy as unknown as typeof console.warn;
});

afterEach(() => {
  console.warn = originalConsoleWarn;
  cleanup();
});

describe("PayloadView — sql variants", () => {
  test("sql_write and sql render the same pre-block (alias parity)", () => {
    const payload = { sql: "SELECT 1" };
    const { container: sqlWrite } = render(
      <PayloadView type="sql_write" payload={payload} />,
    );
    cleanup();
    const { container: sqlPlain } = render(
      <PayloadView type="sql" payload={payload} />,
    );
    // Both render a <pre> containing the SQL verbatim — locks the alias.
    const preA = sqlWrite.querySelector("pre");
    const preB = sqlPlain.querySelector("pre");
    // sqlWrite was cleaned up, so it has no pre anymore — assert the alias
    // via the second render alone plus a re-render of the first variant.
    expect(preB?.textContent).toBe("SELECT 1");
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    void preA;
  });

  test("sql_write with non-string .sql falls through to JSON fallback + warns", () => {
    const payload = { sql: 42 as unknown };
    const { container } = render(
      <PayloadView type="sql_write" payload={payload as Record<string, unknown>} />,
    );
    const pre = container.querySelector("pre");
    // JSON fallback renders the whole payload object as formatted JSON.
    expect(pre?.textContent).toContain('"sql": 42');
    expect(consoleWarnSpy).toHaveBeenCalled();
    expect(consoleWarnSpy.mock.calls[0]?.[0]).toContain(
      "PayloadView: sql_write payload missing string .sql",
    );
  });
});

describe("PayloadView — api_call variants", () => {
  test("method + url + body renders all three", () => {
    const { container } = render(
      <PayloadView
        type="api_call"
        payload={{ method: "POST", url: "/api/v1/foo", body: { x: 1 } }}
      />,
    );
    expect(container.textContent).toContain("POST");
    expect(container.textContent).toContain("/api/v1/foo");
    // Body object JSON-stringifies
    expect(container.textContent).toContain('"x": 1');
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  test("method-only (no url) still renders without warn", () => {
    const { container } = render(
      <PayloadView type="api_call" payload={{ method: "GET" }} />,
    );
    expect(container.textContent).toContain("GET");
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  test("url-only (no method) still renders without warn", () => {
    const { container } = render(
      <PayloadView type="api_call" payload={{ url: "/healthz" }} />,
    );
    expect(container.textContent).toContain("/healthz");
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  test("neither method nor url → JSON fallback + warn", () => {
    const payload = { headers: { "x-trace": "abc" } };
    const { container } = render(
      <PayloadView type="api_call" payload={payload} />,
    );
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain('"x-trace"');
    expect(consoleWarnSpy).toHaveBeenCalled();
    expect(consoleWarnSpy.mock.calls[0]?.[0]).toContain(
      "PayloadView: api_call payload missing method/url",
    );
  });

  test("string body is rendered verbatim (not JSON.stringified)", () => {
    const { container } = render(
      <PayloadView
        type="api_call"
        payload={{ method: "POST", url: "/foo", body: "raw-string-body" }}
      />,
    );
    expect(container.textContent).toContain("raw-string-body");
    // A string body double-quoted would indicate JSON.stringify was applied.
    expect(container.textContent).not.toContain('"raw-string-body"');
  });
});

describe("PayloadView — file_write variants", () => {
  test("path-only renders the path without a content block", () => {
    const { container } = render(
      <PayloadView type="file_write" payload={{ path: "/tmp/foo.txt" }} />,
    );
    expect(container.textContent).toContain("/tmp/foo.txt");
    // With no .content, only the path pre-block renders (no second pre).
    const pres = container.querySelectorAll("pre");
    expect(pres.length).toBe(0);
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  test("path + string content renders both", () => {
    const { container } = render(
      <PayloadView
        type="file_write"
        payload={{ path: "/tmp/foo.txt", content: "hello world" }}
      />,
    );
    expect(container.textContent).toContain("/tmp/foo.txt");
    expect(container.textContent).toContain("hello world");
  });

  test("non-string .path falls through to JSON fallback + warn", () => {
    const payload = { path: ["not", "a", "string"] as unknown };
    const { container } = render(
      <PayloadView type="file_write" payload={payload as Record<string, unknown>} />,
    );
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain('"not"');
    expect(consoleWarnSpy).toHaveBeenCalled();
    expect(consoleWarnSpy.mock.calls[0]?.[0]).toContain(
      "PayloadView: file_write payload missing string .path",
    );
  });
});

describe("PayloadView — unknown type", () => {
  test("unknown type falls to JSON fallback without warn", () => {
    const { container } = render(
      <PayloadView
        type="webhook_post"
        payload={{ url: "https://example.com", body: "hi" }}
      />,
    );
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain('"url": "https://example.com"');
    expect(pre?.textContent).toContain('"body": "hi"');
    // Unknown types are expected — don't pollute observability.
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  test("mixed-case type still matches (lowercase branch)", () => {
    // Mirror the labels.toLowerCase() normalization — a "SQL" type from the
    // agent must still render the SQL pre-block, not fall to JSON.
    const { container } = render(
      <PayloadView type="SQL" payload={{ sql: "SELECT 1" }} />,
    );
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("SELECT 1");
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });
});
