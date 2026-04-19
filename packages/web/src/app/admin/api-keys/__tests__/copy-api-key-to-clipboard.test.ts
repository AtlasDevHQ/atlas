import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import {
  copyApiKeyToClipboard,
  COPY_FALLBACK_MESSAGE,
} from "../copy-api-key";

const KEY = "atlas_live_abc123def456";

let originalClipboard: PropertyDescriptor | undefined;
let originalConsoleWarn: typeof console.warn;
let warnMock: ReturnType<typeof mock>;

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    writable: true,
    configurable: true,
  });
}

describe("copyApiKeyToClipboard", () => {
  beforeEach(() => {
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    originalConsoleWarn = console.warn;
    warnMock = mock(() => {});
    console.warn = warnMock;
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      delete (navigator as unknown as { clipboard?: unknown }).clipboard;
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
    expect(setCopyError).not.toHaveBeenCalledWith(COPY_FALLBACK_MESSAGE);
    expect(warnMock).not.toHaveBeenCalled();
  });

  test("failure: surfaces fallback message, logs the error, clears copied", async () => {
    const denial = new Error("Permissions-Policy: clipboard-write denied");
    stubClipboard(() => Promise.reject(denial));

    const setCopied = mock(() => {});
    const setCopyError = mock(() => {});

    await copyApiKeyToClipboard({ text: KEY, setCopied, setCopyError });

    expect(setCopyError).toHaveBeenCalledWith(COPY_FALLBACK_MESSAGE);
    expect(setCopied).toHaveBeenCalledWith(false);
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [label, message] = warnMock.mock.calls[0] as [string, string];
    expect(label).toBe("API key clipboard write failed:");
    expect(message).toBe(denial.message);
  });

  test("failure: handles non-Error rejections by stringifying them", async () => {
    stubClipboard(() => Promise.reject("clipboard unavailable"));

    const setCopied = mock(() => {});
    const setCopyError = mock(() => {});

    await copyApiKeyToClipboard({ text: KEY, setCopied, setCopyError });

    expect(setCopyError).toHaveBeenCalledWith(COPY_FALLBACK_MESSAGE);
    const [, message] = warnMock.mock.calls[0] as [string, string];
    expect(message).toBe("clipboard unavailable");
  });
});
