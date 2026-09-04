/**
 * `ui/components/chat/error-banner` — ErrorBanner and ActionErrorBanner.
 *
 * Merged 2026-09-04; formerly also action-error-banner.test.tsx.
 */

import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import {
  ErrorBanner,
  ActionErrorBanner,
  clearFailureOfKind,
  type StoredActionFailure,
} from "../components/chat/error-banner";

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

  test("renders no_capability distinctly from no_datasource", () => {
    // #4826 — a knowledge-only or brain-only workspace that has genuinely
    // nothing connected must not be told to configure a data source env var.
    const err = makeError({
      error: "no_capability",
      message: "Connect a data source, add a Knowledge Base collection, or let the Company Atlas learn.",
    });
    const { container } = render(
      <ErrorBanner error={err} authMode="none" />,
    );
    expect(container.textContent).toContain("This workspace has no data yet");
    expect(container.textContent).toContain("Knowledge Base");
    expect(container.textContent).not.toContain("ATLAS_DATASOURCE_URL");
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

  test("shows Try again button for retryable errors when onRetry provided", () => {
    const onRetry = mock(() => {});
    const err = makeError({ error: "provider_timeout", message: "timed out" });
    const { container } = render(
      <ErrorBanner error={err} authMode="none" onRetry={onRetry} />,
    );
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Try again");
    fireEvent.click(button!);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("does not show Try again button for non-retryable errors", () => {
    const onRetry = mock(() => {});
    const err = makeError({ error: "auth_error" });
    const { container } = render(
      <ErrorBanner error={err} authMode="none" onRetry={onRetry} />,
    );
    expect(container.querySelector("button")).toBeNull();
  });

  test("does not show Try again button when onRetry is not provided", () => {
    const err = makeError({ error: "provider_error", message: "500" });
    const { container } = render(
      <ErrorBanner error={err} authMode="none" />,
    );
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("ActionErrorBanner", () => {
  test("renders title as an alert", () => {
    const { getByRole } = render(
      <ActionErrorBanner failure={{ title: "Couldn't pin starter prompt" }} />,
    );
    const alert = getByRole("alert");
    expect(alert.textContent).toContain("Couldn't pin starter prompt");
  });

  test("renders detail and request ID when present", () => {
    const { container } = render(
      <ActionErrorBanner
        failure={{
          title: "Couldn't pin starter prompt",
          detail: "Favorites are limited to 20 prompts.",
          requestId: "req-123",
        }}
      />,
    );
    expect(container.textContent).toContain("Favorites are limited to 20 prompts.");
    expect(container.textContent).toContain("Request ID: req-123");
  });

  test("omits detail and request ID rows when absent", () => {
    const { container } = render(
      <ActionErrorBanner failure={{ title: "Message failed to send" }} />,
    );
    // With no detail, requestId, retry, or dismiss, the title is the ONLY text.
    expect(container.textContent?.trim()).toBe("Message failed to send");
  });

  test("retry button invokes the failure's retry and renders only when provided", () => {
    const retry = mock(() => {});
    const { getByText, rerender, queryByText } = render(
      <ActionErrorBanner failure={{ title: "Message failed to send", retry }} />,
    );
    fireEvent.click(getByText("Try again"));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(<ActionErrorBanner failure={{ title: "Message failed to send" }} />);
    expect(queryByText("Try again")).toBeNull();
  });

  test("dismiss button invokes onDismiss and renders only when provided", () => {
    const onDismiss = mock(() => {});
    const { getByLabelText, rerender, queryByLabelText } = render(
      <ActionErrorBanner
        failure={{ title: "Couldn't unpin starter prompt" }}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(getByLabelText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    rerender(<ActionErrorBanner failure={{ title: "Couldn't unpin starter prompt" }} />);
    expect(queryByLabelText("Dismiss")).toBeNull();
  });
});

// #4297 — the kind-scoped clear discipline: machine-initiated / implicit
// clears may only supersede their own kind, never an unrelated failure the
// user hasn't seen.
describe("clearFailureOfKind", () => {
  const pinFailure: StoredActionFailure = {
    kind: "pin",
    title: "Couldn't pin starter prompt",
  };

  test("clears a failure of the matching kind", () => {
    expect(clearFailureOfKind("pin")(pinFailure)).toBeNull();
  });

  test("preserves a failure of a different kind by identity (setState bail-out)", () => {
    expect(clearFailureOfKind("resume")(pinFailure)).toBe(pinFailure);
  });

  test("passes through null", () => {
    expect(clearFailureOfKind("send")(null)).toBeNull();
  });
});
