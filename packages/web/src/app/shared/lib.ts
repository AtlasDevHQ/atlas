// ---------------------------------------------------------------------------
// Shared utilities for the public conversation route (/shared/[token] + embed).
// The data fetch lives in `[token]/fetch.ts` (server-only, #4719); this module
// stays free of server-only imports so client components (e.g. the org-share
// resolver) can import the types + text helpers.
// ---------------------------------------------------------------------------

export interface SharedMessage {
  /** Message author role. Kept as `string` (not a closed union): the views
   *  only branch on "user"/"assistant" and hide everything else, and the
   *  boundary validation (`[token]/share-result.ts`) checks string-ness only —
   *  a narrower type here would assert an invariant nothing enforces. */
  role: string;
  content: unknown;
  createdAt: string;
}

export interface SharedConversation {
  title: string | null;
  surface: string;
  createdAt: string;
  messages: SharedMessage[];
}

export function getApiBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_ATLAS_API_URL ||
    process.env.ATLAS_API_URL ||
    "http://localhost:3001"
  ).replace(/\/+$/, "");
}

/**
 * Extract displayable text from AI SDK message content (string or array-of-parts format).
 * Returns an empty string for unrecognized content shapes (null, undefined, non-array objects).
 */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: "text"; text: string } =>
          typeof p === "object" &&
          p !== null &&
          p.type === "text" &&
          typeof p.text === "string",
      )
      .map((p) => p.text)
      .join(" ");
  }
  if (content != null) {
    console.warn(
      "[shared-conversation] Unrecognized content shape:",
      typeof content,
    );
  }
  return "";
}

/** Collapse whitespace and truncate to `maxLen` characters, appending a Unicode ellipsis if truncated. */
export function truncate(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 1) + "\u2026";
}
