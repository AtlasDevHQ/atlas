import { describe, expect, test, mock, beforeEach } from "bun:test";
import { render, fireEvent } from "@testing-library/react";
import { CopyButton } from "../components/chat/copy-button";

describe("CopyButton", () => {
  const writeTextMock = mock(() => Promise.resolve());

  beforeEach(() => {
    writeTextMock.mockClear();
    // Use defineProperty to override readonly clipboard
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });
  });

  test("renders default label", () => {
    const { container } = render(<CopyButton text="hello" />);
    expect(container.textContent).toBe("Copy");
  });

  test("renders custom label", () => {
    const { container } = render(<CopyButton text="hello" label="Copy SQL" />);
    expect(container.textContent).toBe("Copy SQL");
  });

  test("copies text to clipboard on click", async () => {
    const { container } = render(<CopyButton text="SELECT 1" />);
    const button = container.querySelector("button")!;
    fireEvent.click(button);

    await new Promise((r) => setTimeout(r, 10));
    expect(writeTextMock).toHaveBeenCalledWith("SELECT 1");
  });

  test("shows Copied! after successful copy", async () => {
    const { container } = render(<CopyButton text="hello" />);
    const button = container.querySelector("button")!;
    fireEvent.click(button);

    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe("Copied!");
  });

  test("shows Failed when clipboard write fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mock(() => Promise.reject(new Error("denied"))) },
      writable: true,
      configurable: true,
    });

    const { container } = render(<CopyButton text="hello" />);
    const button = container.querySelector("button")!;
    fireEvent.click(button);

    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe("Failed");
  });
});
