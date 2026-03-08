import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
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

  test("renders provider errors", () => {
    for (const code of [
      "provider_model_not_found",
      "provider_auth_error",
      "provider_rate_limit",
      "provider_timeout",
      "provider_unreachable",
      "provider_error",
    ]) {
      const err = makeError({ error: code });
      const { container } = render(
        <ErrorBanner error={err} authMode="none" />,
      );
      // All provider errors should render something (not crash)
      expect(container.textContent!.length).toBeGreaterThan(0);
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
