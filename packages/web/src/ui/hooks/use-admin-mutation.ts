"use client";

import { useState, useCallback, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtlasConfig } from "@/ui/context";
import { buildFetchError, extractFetchError, type FetchError } from "@/ui/lib/fetch-error";
import { ADMIN_FETCH_QUERY_KEY } from "@/ui/hooks/admin-query-keys";

/** HTTP methods supported by admin mutations. */
type MutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Discriminated result returned by `mutate()`.
 * Discriminates on `ok`: true means the request succeeded (data is
 * undefined for 204 No Content or non-JSON responses), false means
 * an error occurred. `error` is the structured {@link FetchError} so callers
 * can pass it to `friendlyError()` or branch on `code === "enterprise_required"`
 * without re-parsing the message string.
 */
export type MutateResult<T> =
  | { ok: true; data: T | undefined }
  | { ok: false; error: FetchError };

/** Options for a single mutate() call. */
interface MutateOptions<TResponse = unknown> {
  /** Override the path from the hook-level default. */
  path?: string;
  /** HTTP method. Defaults to hook-level method or "POST". */
  method?: MutationMethod;
  /** JSON request body. */
  body?: Record<string, unknown>;
  /** Track this mutation under an ID for per-item loading state. */
  itemId?: string;
  /**
   * Called on any 2xx response. Data is `undefined` for 204 No Content or non-JSON
   * responses — consumers that need the parsed body should narrow or use the
   * `MutateResult` returned from `mutate()`.
   */
  onSuccess?: (data: TResponse | undefined) => void;
}

/** Hook-level configuration. */
interface UseAdminMutationOptions {
  /** Default API path (e.g. "/api/v1/admin/branding"). Can be overridden per-call. */
  path?: string;
  /** Default HTTP method. Defaults to "POST". */
  method?: MutationMethod;
  /** Refetch functions to call after a successful mutation. */
  invalidates?: (() => void) | (() => void)[];
}

/** Return value of useAdminMutation. */
interface UseAdminMutationReturn<TResponse> {
  /** Execute a mutation. Resolves with a discriminated `{ ok, data }` or `{ ok, error }` result. */
  mutate: (options?: MutateOptions<TResponse>) => Promise<MutateResult<TResponse>>;
  /** True while any non-item-scoped mutation is in flight. */
  saving: boolean;
  /**
   * Last mutation error as a structured {@link FetchError}, or null.
   * Feed into `friendlyError()` for banner copy, or branch on
   * `code === "enterprise_required"` / `status` directly — the structured
   * fields stay intact so `AdminContentWrapper` can route EE 403s into
   * `EnterpriseUpsell` instead of a generic banner. Stays `FetchError`
   * (not flattened to `string`) specifically so the `code`, `status`, and
   * `requestId` fields survive the hook boundary — wrapping it as
   * `{ message: error.message }` re-flattens and is guarded by an ESLint
   * rule in `eslint.config.mjs`.
   *
   * Clearing semantics intentionally differ for itemized vs non-itemized
   * calls:
   * - **Non-itemized** `mutate()` — cleared at the start of the next call
   *   (stale error from a prior failed attempt is implicitly dismissed when
   *   the user retries).
   * - **Itemized** `mutate({ itemId })` — NOT cleared at the start of the
   *   next call, so concurrent bulk fan-out (`Promise.all` / `allSettled`)
   *   can't stomp a prior item's error via the start-of-mutate reset (#1629).
   *   For bulk readers, prefer the per-item map via `errorFor(id)` — this
   *   slot still surfaces a last-wins banner for single-row UX.
   * - An itemized call that **succeeds** clears this slot only when it was
   *   the same itemId that last populated it. If other itemIds still hold
   *   errors, one is promoted into this slot so the banner tracks the map
   *   instead of going empty while `errorsByItemId` still reports failures.
   * - `clearError()` dismisses this slot only — per-item state is managed
   *   independently via `clearErrorFor(id)` or `reset()`.
   */
  error: FetchError | null;
  /**
   * Per-item error map — populated when `mutate({ itemId })` fails, cleared
   * when the same itemId's next mutate call starts or succeeds. Reliable
   * under concurrent fan-out (each itemId owns its own slot), unlike the
   * shared hook-level `error`.
   *
   * Prefer `errorFor(id)` for lookup; the raw map is exposed for callers
   * that need to render multiple per-item banners in one pass (e.g. bulk
   * summaries) or iterate over failed ids.
   */
  errorsByItemId: Readonly<Record<string, FetchError>>;
  /** Lookup helper for {@link errorsByItemId}. */
  errorFor: (itemId: string) => FetchError | undefined;
  /** Clear the hook-level error manually. */
  clearError: () => void;
  /** Clear a single itemId's error without touching other slots. */
  clearErrorFor: (itemId: string) => void;
  /** Reset all error slots and in-flight state (e.g. when a dialog reopens). */
  reset: () => void;
  /** Check whether a per-item mutation is in flight. */
  isMutating: (itemId: string) => boolean;
}

/**
 * Hook for admin page mutations (POST, PUT, PATCH, DELETE).
 *
 * Uses TanStack Query's `useMutation` internally. On success, invalidates
 * all `["admin-fetch"]` queries so `useAdminFetch` consumers automatically
 * refetch. Preserves the original return shape for backward compatibility.
 */
export function useAdminMutation<TResponse = unknown>(
  options?: UseAdminMutationOptions,
): UseAdminMutationReturn<TResponse> {
  const { apiUrl, isCrossOrigin } = useAtlasConfig();
  const credentials: RequestCredentials = isCrossOrigin ? "include" : "same-origin";
  const queryClient = useQueryClient();

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<FetchError | null>(null);
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  const [errorsByItemId, setErrorsByItemIdState] =
    useState<Record<string, FetchError>>({});

  // Synchronous mirror of `errorsByItemId`. The promote-on-clear logic needs
  // to read the map *after* a delete to decide whether to clear the hook-level
  // slot or promote a surviving entry into it. A functional `setState` updater
  // alone can't do both — the updated value is only observable after React
  // schedules the re-render. Pairing state with a ref keeps both in lockstep
  // and makes `updateErrorsByItemId` synchronously readable.
  const errorsByItemIdRef = useRef<Record<string, FetchError>>({});

  // Tracks which itemId (if any) last populated hook-level `error`. Used to
  // decide whether an itemized success/clear should dismiss the shared banner:
  // only the current owner may clear it, and if other itemIds still have
  // errors, ownership promotes to one of them instead of leaving the banner
  // empty while the map still reports failures.
  const errorItemIdRef = useRef<string | null>(null);

  // Generation counter that increments on `reset()`. An in-flight mutation's
  // catch/success handlers check this before writing state — if the caller
  // reset the hook after the request was dispatched, any late settlement
  // must NOT repopulate the slots the reset just cleared. Without this, a
  // dialog that calls `reset()` on close would see a phantom banner reappear
  // on its next open when the stale request finally settles.
  const generationRef = useRef(0);

  // Ref to read latest hook-level options inside mutationFn without recreating the mutation.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const updateErrorsByItemId = useCallback(
    (next: Record<string, FetchError>) => {
      errorsByItemIdRef.current = next;
      setErrorsByItemIdState(next);
    },
    [],
  );

  // Called when the current hook-level owner's slot is being removed. If any
  // itemId still has a per-item error, one is promoted into the shared slot
  // so the banner stays consistent with `errorsByItemId`; otherwise the slot
  // is cleared. Never called for non-owning clears (the hook-level slot isn't
  // ours to touch in that case).
  const promoteOrClearHookLevel = useCallback(() => {
    const remaining = errorsByItemIdRef.current;
    let nextId: string | undefined;
    for (const key in remaining) {
      nextId = key;
      break;
    }
    if (nextId !== undefined) {
      setError(remaining[nextId]!);
      errorItemIdRef.current = nextId;
    } else {
      setError(null);
      errorItemIdRef.current = null;
    }
  }, []);

  const clearError = useCallback(() => {
    // Narrow dismissal: the user dismissed the shared banner, but per-item
    // state is a separate surface (row markers, retry affordances) that the
    // caller manages independently. Clearing only the hook-level slot leaves
    // `errorsByItemId` untouched so bulk surfaces stay in sync with which
    // rows are still broken. Use `clearErrorFor(id)` or `reset()` to dismiss
    // per-item entries.
    setError(null);
    errorItemIdRef.current = null;
  }, []);

  const clearErrorFor = useCallback(
    (itemId: string) => {
      const prev = errorsByItemIdRef.current;
      if (itemId in prev) {
        const next = { ...prev };
        delete next[itemId];
        updateErrorsByItemId(next);
      }
      // If this itemId owned the hook slot, let another surviving item take
      // over — otherwise the banner goes empty while the map still reports
      // failures elsewhere.
      if (errorItemIdRef.current === itemId) {
        promoteOrClearHookLevel();
      }
    },
    [updateErrorsByItemId, promoteOrClearHookLevel],
  );

  const reset = useCallback(() => {
    // Bump the generation so any currently in-flight mutation that settles
    // after this point declines to write state (its `callGen` won't match).
    generationRef.current += 1;
    setError(null);
    setSaving(false);
    setInFlight(new Set());
    updateErrorsByItemId({});
    errorItemIdRef.current = null;
  }, [updateErrorsByItemId]);

  const isMutating = useCallback(
    (itemId: string) => inFlight.has(itemId),
    [inFlight],
  );

  // `errorsByItemId` is already a stable Record snapshot per render — a
  // straight closure avoids an extra memo + dep and matches how `isMutating`
  // reads `inFlight`.
  const errorFor = useCallback(
    (itemId: string): FetchError | undefined => errorsByItemId[itemId],
    [errorsByItemId],
  );

  const mutation = useMutation<TResponse | undefined, Error, MutateOptions<TResponse> | undefined>({
    mutationFn: async (callOpts) => {
      const opts = optionsRef.current;
      const path = callOpts?.path ?? opts?.path;
      const method = callOpts?.method ?? opts?.method ?? "POST";

      if (!path) {
        throw new Error("useAdminMutation: no path provided");
      }

      const headers: Record<string, string> = {};
      let body: string | undefined;
      if (callOpts?.body) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(callOpts.body);
      }

      const res = await fetch(`${apiUrl}${path}`, {
        method,
        credentials,
        headers,
        body,
      });

      if (!res.ok) {
        const fetchError = await extractFetchError(res);
        // Preserve the structured FetchError across the throw boundary so the
        // catch in `mutate()` can return it as `MutateResult.error`. The bare
        // `Error.message` is kept human-readable as a fallback for anything
        // that inspects the thrown error directly (e.g. TanStack's own logs).
        const msg = fetchError.requestId
          ? `${fetchError.message} (Request ID: ${fetchError.requestId})`
          : fetchError.message;
        throw Object.assign(new Error(msg), { fetchError });
      }

      // Parse response (handle 204 No Content)
      const contentType = res.headers.get("content-type");
      if (res.status === 204 || !contentType?.includes("application/json")) {
        return undefined;
      }
      return (await res.json()) as TResponse;
    },
    onSuccess: () => {
      // Invalidate all admin-fetch queries so useAdminFetch consumers get fresh data.
      // This is intentionally broad — can be narrowed to specific keys if needed.
      queryClient.invalidateQueries({ queryKey: [ADMIN_FETCH_QUERY_KEY] });
    },
  });

  // Ref for stable mutate callback — useMutation returns a new object each render.
  const mutationRef = useRef(mutation);
  mutationRef.current = mutation;

  const mutate = useCallback(
    async (callOpts?: MutateOptions<TResponse>): Promise<MutateResult<TResponse>> => {
      const opts = optionsRef.current;
      const itemId = callOpts?.itemId;
      // Snapshot at dispatch time; any late settlement that arrives after a
      // `reset()` (which bumps this) declines to write state.
      const callGen = generationRef.current;

      if (!callOpts?.path && !opts?.path) {
        const fetchError = buildFetchError({
          message: "useAdminMutation: no path provided",
        });
        // Populate both slots for itemized callers — a bulk surface reading
        // only `errorFor(id)` would otherwise miss the failure and the row
        // would silently look healthy.
        if (itemId) {
          const next = { ...errorsByItemIdRef.current, [itemId]: fetchError };
          updateErrorsByItemId(next);
        }
        setError(fetchError);
        errorItemIdRef.current = itemId ?? null;
        return { ok: false, error: fetchError };
      }

      // Start-of-mutate clearing is deliberately asymmetric between itemized
      // and non-itemized calls. Non-itemized: clear hook-level `error` so a
      // new attempt dismisses the stale banner for this mutation slot.
      // Itemized: clear ONLY this itemId's per-item slot. Touching the
      // hook-level slot here is what caused concurrent bulk fan-out to
      // stomp each other's errors (#1629).
      if (itemId) {
        setInFlight((prev) => new Set(prev).add(itemId));
        const prev = errorsByItemIdRef.current;
        if (itemId in prev) {
          const next = { ...prev };
          delete next[itemId];
          updateErrorsByItemId(next);
        }
      } else {
        setSaving(true);
        setError(null);
        errorItemIdRef.current = null;
      }

      let data: TResponse | undefined;
      try {
        data = await mutationRef.current.mutateAsync(callOpts);
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        // Recover the structured FetchError the mutationFn attached before
        // throwing (non-HTTP failures like network errors reach this path with
        // no attachment — route through `buildFetchError` so the empty-message
        // invariant applies even to the network-error fallback path). Default
        // to a generic "Request failed" when the caught value has no message
        // so the helper's dev-throw doesn't escape the hook and break the
        // `mutate()` contract that resolves to `{ ok: false, error }`. Real
        // hand-constructed `{ message: "" }` literals still trip the throw.
        const fetchError =
          (err as { fetchError?: FetchError }).fetchError ??
          buildFetchError({ message: rawMsg.trim() ? rawMsg : "Request failed" });

        if (generationRef.current !== callGen) {
          // `reset()` ran after this mutation was dispatched — swallow the
          // state writes so the caller's clean slate holds. The promise still
          // resolves to `{ ok: false, error }` so the direct `await` path
          // reports the failure; the discrepancy is the hook-level state,
          // which the caller explicitly asked to clear.
          return { ok: false, error: fetchError };
        }

        if (itemId) {
          const nextMap = { ...errorsByItemIdRef.current, [itemId]: fetchError };
          updateErrorsByItemId(nextMap);
        }
        // Mirror to hook-level `error` in both cases so the many single-row
        // callers that read `mutation.error` continue to surface failures
        // without migration. Concurrent itemized failures are "last wins"
        // here (documented on the `error` field) — bulk callers should read
        // `errorsByItemId` / `errorFor(id)` for per-item resolution.
        setError(fetchError);
        errorItemIdRef.current = itemId ?? null;
        return { ok: false, error: fetchError };
      } finally {
        if (itemId) {
          setInFlight((prev) => {
            if (!prev.has(itemId)) return prev;
            const next = new Set(prev);
            next.delete(itemId);
            return next;
          });
        } else {
          setSaving(false);
        }
      }

      if (generationRef.current !== callGen) {
        // Reset during flight — same rationale as the catch path.
        return { ok: true, data };
      }

      // Successful itemized mutation: clear that itemId's per-item slot. If
      // this itemId owns the hook-level slot, promote a surviving entry into
      // it so the banner tracks the map — otherwise the three-party handoff
      // (A fails, B fails, B retries to success) would silently blank the
      // banner while A is still broken.
      if (itemId) {
        const prev = errorsByItemIdRef.current;
        if (itemId in prev) {
          const next = { ...prev };
          delete next[itemId];
          updateErrorsByItemId(next);
        }
        if (errorItemIdRef.current === itemId) {
          promoteOrClearHookLevel();
        }
      }

      // Invalidates and onSuccess run outside the try/catch above so a
      // throwing user callback does NOT masquerade as a mutation failure —
      // the catch returns early with `ok: false`, so control only falls
      // through on successful fetch. Each callback is isolated in its own
      // try/catch so one throwing refetch doesn't starve the rest; warn-log
      // the throw because these are unexpected (usually a stale closure or a
      // refetch hitting an unmounted component) and the caller needs to see
      // them in production devtools — `console.debug` is filtered out in
      // default log levels and would hide exactly the bug class these logs
      // exist to surface.
      const invalidates = opts?.invalidates;
      if (invalidates) {
        const fns = Array.isArray(invalidates) ? invalidates : [invalidates];
        for (const fn of fns) {
          try {
            fn();
          } catch (err) {
            console.warn("useAdminMutation: invalidates() callback threw", err);
          }
        }
      }
      // onSuccess fires on all 2xx responses — passes `undefined` for 204 /
      // non-JSON so dialog-closing callers aren't stuck when the server
      // returns No Content.
      try {
        callOpts?.onSuccess?.(data);
      } catch (err) {
        console.warn("useAdminMutation: onSuccess callback threw", err);
      }

      return { ok: true, data };
    },
    [], // Stable — reads all mutable state via refs
  );

  return {
    mutate,
    saving,
    error,
    errorsByItemId,
    errorFor,
    clearError,
    clearErrorFor,
    reset,
    isMutating,
  };
}
