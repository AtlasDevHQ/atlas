// ---------------------------------------------------------------------------
// Shared utilities for the public shared-conversation routes (/shared/[token])
// ---------------------------------------------------------------------------

export interface SharedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: unknown;
  createdAt: string;
}

export interface SharedConversation {
  title: string | null;
  surface: string;
  createdAt: string;
  messages: SharedMessage[];
}

export type FetchResult =
  | { ok: true; data: SharedConversation }
  | { ok: false; reason: "not-found" | "expired" | "auth-required" | "server-error" | "network-error" };

export function getApiBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_ATLAS_API_URL ||
    process.env.ATLAS_API_URL ||
    "http://localhost:3001"
  ).replace(/\/+$/, "");
}

export async function fetchSharedConversation(
  token: string,
): Promise<FetchResult> {
  try {
    const res = await fetch(
      `${getApiBaseUrl()}/api/public/conversations/${encodeURIComponent(token)}`,
      // Cache for 60s — balances load vs. freshness when a share link is revoked.
      // Next.js revalidate also deduplicates multiple fetches within a single
      // render pass (e.g. generateMetadata + page component on the full page).
      { next: { revalidate: 60 } },
    );
    if (!res.ok) {
      if (res.status === 404) return { ok: false, reason: "not-found" };
      if (res.status === 410) return { ok: false, reason: "expired" };
      if (res.status === 401) return { ok: false, reason: "auth-required" };
      console.error(
        `[shared-conversation] API returned ${res.status} for token=${token}`,
      );
      return { ok: false, reason: "server-error" };
    }
    const data = await res.json();
    if (!data || !Array.isArray(data.messages)) {
      console.error(
        `[shared-conversation] Unexpected response shape for token=${token}`,
      );
      return { ok: false, reason: "server-error" };
    }
    return { ok: true, data: data as SharedConversation };
  } catch (err) {
    console.error(
      `[shared-conversation] Failed to fetch token=${token}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "network-error" };
  }
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
