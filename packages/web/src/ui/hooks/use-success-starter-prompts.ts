"use client";

import { fetchStarterPrompts } from "@useatlas/sdk";
import { useQuery } from "@tanstack/react-query";
import { getApiUrl, isCrossOrigin } from "@/lib/api-url";
import { STATIC_STARTER_PROMPTS } from "@/ui/lib/starter-prompt-fallback";

const SUCCESS_STARTER_PROMPTS_LIMIT = 6;

export interface UseSuccessStarterPromptsResult {
  /** Prompt texts to offer — adaptive when available, static fallback otherwise. */
  readonly prompts: readonly string[];
  /** True while the adaptive list is still resolving (the static set is shown meanwhile). */
  readonly loading: boolean;
  /** True when `prompts` is the static fallback rather than the adaptive list. */
  readonly isFallback: boolean;
  /**
   * True when the adaptive fetch rejected (a 4xx from the SDK — auth / rate
   * limit / bad request). The page still shows the static fallback (a red
   * banner on a celebratory surface is worse), but this keeps the failure
   * distinguishable from a benign cold-start for any consumer that wants to
   * react to it, rather than collapsing both into `isFallback`.
   */
  readonly isError: boolean;
  /** The rejection reason when `isError`, else null. */
  readonly error: Error | null;
}

/**
 * Resolve the starter prompts to offer on the post-signup success page.
 *
 * The page lives in the main app's authenticated tree, so the adaptive
 * resolver (`/api/v1/starter-prompts`) runs against the freshly-created
 * workspace via the session cookie — the same source the in-chat empty state
 * uses (#3935 §F4). When that resolver yields an empty list — a brand-new
 * workspace whose semantic-layer library hasn't produced prompts yet, or a
 * transient backend fault that soft-fails to `[]` (5xx) — we fall back to the
 * shared static set so the page never shows an empty "try one of these"
 * section.
 *
 * Returns plain prompt texts (not the provenance-tagged wire shape) because
 * the success page only navigates with `?prompt=<text>` — it has no pin /
 * unpin affordance, so the badges and namespaced ids are irrelevant here.
 */
export function useSuccessStarterPrompts(): UseSuccessStarterPromptsResult {
  const apiUrl = getApiUrl();
  const crossOrigin = isCrossOrigin();

  const query = useQuery({
    // Distinct from the in-chat `useStarterPromptsQuery` key
    // (`["atlas", "starter-prompts", apiUrl]`): this hook authenticates via the
    // session cookie with no Authorization header, so it must not share a cache
    // entry with the header-driven chat query — same `apiUrl`, different request
    // inputs. The extra `"success"` segment isolates the two.
    queryKey: ["atlas", "starter-prompts", "success", apiUrl],
    queryFn: ({ signal }) =>
      fetchStarterPrompts({
        apiUrl,
        credentials: crossOrigin ? "include" : "same-origin",
        // Cookie-authenticated session — no Authorization header to attach.
        headers: {},
        signal,
        limit: SUCCESS_STARTER_PROMPTS_LIMIT,
      }),
    retry: 1,
    staleTime: 60_000,
  });

  const adaptive = (query.data ?? [])
    .map((p) => p.text)
    // Guard the SDK trust boundary: `fetchStarterPrompts` casts the wire body
    // without per-element validation, so a malformed entry could carry a
    // non-string `text`. Drop anything that isn't a usable string rather than
    // rendering a blank, zero-text prompt chip.
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  const useAdaptive = adaptive.length > 0;

  return {
    prompts: useAdaptive ? adaptive : STATIC_STARTER_PROMPTS,
    loading: query.isLoading,
    isFallback: !useAdaptive,
    isError: query.isError,
    error: query.error,
  };
}
