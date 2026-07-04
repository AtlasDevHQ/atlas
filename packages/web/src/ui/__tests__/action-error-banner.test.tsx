import { describe, expect, test, mock } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { ActionErrorBanner } from "../components/chat/error-banner";

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
