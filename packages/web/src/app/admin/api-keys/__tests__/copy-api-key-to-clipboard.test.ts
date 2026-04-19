import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { copyApiKeyToClipboard, COPY_FALLBACK_MESSAGE } from "../page";

const KEY = "atlas_live_abc123def456";

let originalClipboard: typeof navigator.clipboard | undefined;
let originalConsoleWarn: typeof console.warn;

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    writable: true,
    configurable: true,
  });
}

describe("copyApiKeyToClipboard", () => {
  beforeEach(() => {
    originalClipboard = navigator.clipboard;
    originalConsoleWarn = console.warn;
    console.warn = mock(() => {});
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", {
        value: originalClipboard,
        writable: true,
        configurable: true,
      });
    }
    console.warn = originalConsoleWarn;
  });

  test("success: writes text, marks copied, clears any prior error", async () => {
    const writeText = mock(() => Promise.resolve());
    stubClipboard(writeText);

    const setCopied = mock(() => {});
    const setCopyError = mock(() => {});

    await copyApiKeyToClipboard({ text: KEY, setCopied, setCopyError });

    expect(writeText).toHaveBeenCalledWith(KEY);
    expect(setCopied).toHaveBeenCalledWith(true);
    expect(setCopyError).toHaveBeenCalledWith(null);
    // Failure-path side effects must not fire on success.
    expect(setCopyError).not.toHaveBeenCalledWith(COPY_FALLBACK_MESSAGE);
    expect(console.warn).not.toHaveBeenCalled();
  });

  test("failure: surfaces fallback message, logs the error, clears copied", async () => {
    const denial = new Error("Permissions-Policy: clipboard-write denied");
    const writeText = mock(() => Promise.reject(denial));
    stubClipboard(writeText);

    const setCopied = mock(() => {});
    const setCopyError = mock(() => {});

    await copyApiKeyToClipboard({ text: KEY, setCopied, setCopyError });

    expect(setCopyError).toHaveBeenCalledWith(COPY_FALLBACK_MESSAGE);
    expect(setCopied).toHaveBeenCalledWith(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
    const [label, message] = (console.warn as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(label).toBe("API key clipboard write failed:");
    expect(message).toBe(denial.message);
  });

  test("failure: handles non-Error rejections by stringifying them", async () => {
    const writeText = mock(() => Promise.reject("clipboard unavailable"));
    stubClipboard(writeText);

    const setCopied = mock(() => {});
    const setCopyError = mock(() => {});

    await copyApiKeyToClipboard({ text: KEY, setCopied, setCopyError });

    expect(setCopyError).toHaveBeenCalledWith(COPY_FALLBACK_MESSAGE);
    const [, message] = (console.warn as unknown as ReturnType<typeof mock>).mock.calls[0] as [string, string];
    expect(message).toBe("clipboard unavailable");
  });
});
