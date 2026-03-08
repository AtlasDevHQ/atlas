import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { ErrorBanner } from "../components/chat/error-banner";

function makeError(json: Record<string, unknown>): Error {
  return new Error(JSON.stringify(json));
}

describe("ErrorBanner", () => {
  test("renders generic error for non-JSON message", () => {
    const { container } = render(
      <ErrorBanner error={new Error("something broke")} authMode="none" />,
    );
    expect(container.textContent).toContain("Something went wrong");
  });

  test("renders auth error with simple-key guidance", () => {
    const err = makeError({ error: "auth_error" });
    const { container } = render(
      <ErrorBanner error={err} authMode="simple-key" />,
    );
    expect(container.textContent).toContain("Invalid or missing API key");
  });

  test("renders auth error with managed guidance", () => {
    const err = makeError({ error: "auth_error" });
    const { container } = render(
      <ErrorBanner error={err} authMode="managed" />,
    );
    expect(container.textContent).toContain("session has expired");
  });

  test("renders rate limit with countdown", () => {
    const err = makeError({ error: "rate_limited", retryAfterSeconds: 10 });
    const { container } = render(
      <ErrorBanner error={err} authMode="none" />,
    );
    expect(container.textContent).toContain("Too many requests");
    expect(container.textContent).toContain("10 seconds");
  });

  test("renders configuration error with detail", () => {
    const err = makeError({ error: "configuration_error", message: "Missing ATLAS_DATASOURCE_URL" });
    const { container } = render(
      <ErrorBanner error={err} authMode="none" />,
    );
    expect(container.textContent).toContain("not fully configured");
    expect(container.textContent).toContain("Missing ATLAS_DATASOURCE_URL");
  });

  test("renders no datasource error", () => {
    const err = makeError({ error: "no_datasource", message: "Set ATLAS_DATASOURCE_URL" });
    const { container } = render(
      <ErrorBanner error={err} authMode="none" />,
    );
    expect(container.textContent).toContain("No data source configured");
  });

  test("renders specific message for each provider error", () => {
    const expectations: [string, string][] = [
      ["provider_model_not_found", "model was not found"],
      ["provider_auth_error", "could not authenticate"],
      ["provider_rate_limit", "rate limiting"],
      ["provider_timeout", "timed out"],
      ["provider_unreachable", "Could not reach"],
      ["provider_error", "returned an error"],
    ];
    for (const [code, expected] of expectations) {
      const err = makeError({ error: code });
      const { container } = render(
        <ErrorBanner error={err} authMode="none" />,
      );
      expect(container.textContent).toContain(expected);
    }
  });

  test("renders internal error with server message", () => {
    const err = makeError({ error: "internal_error", message: "DB pool exhausted" });
    const { container } = render(
      <ErrorBanner error={err} authMode="none" />,
    );
    expect(container.textContent).toContain("DB pool exhausted");
  });

  test("renders byot auth error", () => {
    const err = makeError({ error: "auth_error" });
    const { container } = render(
      <ErrorBanner error={err} authMode="byot" />,
    );
    expect(container.textContent).toContain("token may have expired");
  });

  test("has proper error styling (red border)", () => {
    const { container } = render(
      <ErrorBanner error={new Error("oops")} authMode="none" />,
    );
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain("border-red");
  });
});
