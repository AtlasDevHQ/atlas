import { getApiUrl, isCrossOrigin } from "@/lib/api-url";

export type PostJsonResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

function getApiBase(): string {
  const url = getApiUrl();
  if (url) return url;
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
}

function getCredentials(): RequestCredentials {
  return isCrossOrigin() ? "include" : "same-origin";
}

/**
 * POST JSON and parse the response, collapsing network / parse / HTTP errors
 * into a single tagged result. Callers surface `error` directly to the user.
 *
 * Callers that need typed response shapes or latency should keep their own
 * fetch — this helper targets "success → route, failure → show message" flows.
 */
export async function postJson(
  path: string,
  body: unknown,
  opts?: { fallbackMessage?: string },
): Promise<PostJsonResult> {
  const fallback = opts?.fallbackMessage ?? "Request failed";

  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: getCredentials(),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof TypeError ? "Unable to reach the server" : fallback,
    };
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch (parseErr) {
    console.debug("[postJson] JSON parse failed:", {
      path,
      status: res.status,
      contentType: res.headers.get("content-type"),
      err: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
    return { ok: false, error: "Server returned an unexpected response." };
  }

  if (!res.ok) {
    const message = typeof data.message === "string" ? data.message : fallback;
    return { ok: false, error: message };
  }

  return { ok: true, data };
}
