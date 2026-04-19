export const COPY_FALLBACK_MESSAGE =
  "Copy failed — select the key below and copy manually.";

export async function copyApiKeyToClipboard(args: {
  text: string;
  setCopied: (copied: boolean) => void;
  setCopyError: (msg: string | null) => void;
}): Promise<void> {
  const { text, setCopied, setCopyError } = args;
  try {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setCopyError(null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("API key clipboard write failed:", msg);
    setCopied(false);
    setCopyError(COPY_FALLBACK_MESSAGE);
  }
}
