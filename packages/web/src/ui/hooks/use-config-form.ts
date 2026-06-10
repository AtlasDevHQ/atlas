"use client";

import { useState } from "react";
import type { z } from "zod";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import {
  useAdminMutation,
  type MutateResult,
} from "@/ui/hooks/use-admin-mutation";
import { buildFetchError, type FetchError } from "@/ui/lib/fetch-error";

/** HTTP methods that make sense for a whole-config save. */
type SaveMethod = "POST" | "PUT" | "PATCH";

/**
 * Per-field accessor pair. `value` renders into the input; `set` replaces
 * that field. The key set is exactly `Object.keys(toForm(data))`, so adding
 * a field to `toForm` automatically gives it an accessor — and enrolls it
 * in the dirty compare (see {@link UseConfigFormReturn.dirty}).
 */
export type ConfigFormFields<TValues> = {
  [K in keyof TValues]: {
    value: TValues[K];
    set: (next: TValues[K]) => void;
  };
};

export interface UseConfigFormOptions<
  TData,
  TValues extends Record<string, unknown>,
> {
  /** GET path for the config object (e.g. "/api/v1/admin/proactive/workspace"). */
  path: string;
  /** Zod schema for the GET response — passed through to `useAdminFetch`. */
  schema?: z.ZodType<TData>;
  /**
   * Derive form values from fetched data. Must be pure — it runs during
   * render whenever the fetched data changes. The returned object is the
   * single canonical statement of what this form edits: its keys drive the
   * `fields` accessors AND the dirty compare, so a field can't be editable
   * yet missing from the compare.
   */
  toForm: (data: TData) => TValues;
  /**
   * Build the save request body from form values. Defaults to sending the
   * values object as-is. This is where pages trim strings, map "" → null,
   * and parse numeric inputs.
   */
  toPayload?: (values: TValues, data: TData) => Record<string, unknown>;
  /** Save endpoint. Defaults to `path`. */
  savePath?: string;
  /** Save HTTP method. Defaults to "PUT". */
  saveMethod?: SaveMethod;
}

export interface UseConfigFormReturn<
  TData,
  TValues extends Record<string, unknown>,
  TResponse = unknown,
> {
  /** Latest fetched config, or null while loading / on load error. */
  data: TData | null;
  /** True while the initial GET is in flight. */
  loading: boolean;
  /**
   * Load-side error — feed into `AdminContentWrapper`'s `error` prop.
   * Distinct from `error` (the save-side slot) because the two render into
   * different surfaces on every admin page.
   */
  loadError: FetchError | null;
  /** Re-run the GET. */
  refetch: () => void;
  /**
   * Per-field accessors, or null until the first successful load. Pages
   * gate the form section on this (`form.fields ? <Form/> : null`) the same
   * way they previously gated on `data`.
   */
  fields: ConfigFormFields<TValues> | null;
  /** Current form values as one object — for derived validation/preview. */
  values: TValues | null;
  /**
   * True when any field differs from the server-derived baseline. One deep
   * compare of `values` vs `toForm(data)` — there is no per-field compare
   * for a new field to be forgotten from.
   */
  dirty: boolean;
  /** Discard edits — restore values to the server-derived baseline. */
  reset: () => void;
  /**
   * Save the current values: `toPayload(values, data)` → mutation → the
   * mutation's success invalidation refetches the GET, which re-baselines
   * the form, flipping `dirty` back to false. Resolves with the same
   * discriminated result as `useAdminMutation.mutate()`.
   */
  save: () => Promise<MutateResult<TResponse>>;
  /** True while a save is in flight. */
  saving: boolean;
  /** Save-side error — feed into `<MutationErrorSurface>`. */
  error: FetchError | null;
  /** Clear the save-side error manually. */
  clearError: () => void;
}

/**
 * Shared load → edit → dirty → save → re-baseline loop for admin config
 * pages. Composes `useAdminFetch` (read) + `useAdminMutation` (write) and
 * absorbs the state bookkeeping every config page used to hand-wire:
 * per-field useState, the dirty compare, and the reset-on-refetch effect.
 *
 * ```tsx
 * const form = useConfigForm<WireConfig, FormValues>({
 *   path: "/api/v1/admin/thing",
 *   schema: WireConfigSchema,
 *   toForm: (d) => ({ enabled: d.enabled, cap: d.cap === null ? "" : String(d.cap) }),
 *   toPayload: (v) => ({ enabled: v.enabled, cap: v.cap === "" ? null : Number(v.cap) }),
 * });
 * // <Switch checked={form.fields.enabled.value} onCheckedChange={form.fields.enabled.set} />
 * // <Button onClick={form.save} disabled={form.saving || !form.dirty} />
 * ```
 *
 * Re-baseline semantics: the form resets to `toForm(data)` whenever the
 * fetched `data` reference changes. TanStack Query's structural sharing
 * makes reference change ≈ content change, so a background refetch that
 * returns identical data does NOT clobber in-flight edits, while the
 * post-save invalidation refetch resets the form to server truth — the
 * same behavior the hand-wired `useEffect([data])` resets had.
 *
 * Out of scope by design: per-field validation messages (pages derive
 * those from `values`), transient UI state (stays `useState` in the page),
 * URL state (nuqs), and multi-endpoint saves.
 */
export function useConfigForm<
  TData,
  TValues extends Record<string, unknown>,
  TResponse = unknown,
>(
  options: UseConfigFormOptions<TData, TValues>,
): UseConfigFormReturn<TData, TValues, TResponse> {
  const { data, loading, error: loadError, refetch } = useAdminFetch<TData>(
    options.path,
    options.schema ? { schema: options.schema } : undefined,
  );

  // No explicit `invalidates: refetch` — useAdminMutation's onSuccess already
  // invalidates every admin-fetch query, which refetches this one and drives
  // the re-baseline. Passing refetch as well just cancels that in-flight GET
  // and dispatches a second one. The save test below ("re-baselines after a
  // successful save") guards this coupling if the broad invalidation is ever
  // narrowed.
  const mutation = useAdminMutation<TResponse>({
    path: options.savePath ?? options.path,
    method: options.saveMethod ?? "PUT",
  });

  // Re-baseline when the fetched data changes — the React-sanctioned
  // "adjust state during render" pattern (state-stored previous value, not
  // a ref, so it stays render-pure). `data` flips to null on load error;
  // values are kept so an error during a background refetch doesn't eat
  // the user's edits.
  const [prevData, setPrevData] = useState<TData | null | undefined>(undefined);
  const [baseline, setBaseline] = useState<TValues | null>(null);
  const [values, setValues] = useState<TValues | null>(null);
  if (data !== null && data !== prevData) {
    setPrevData(data);
    const next = options.toForm(data);
    setBaseline(next);
    setValues(next);
  }

  function setField<K extends keyof TValues>(key: K, next: TValues[K]) {
    setValues((prev) => (prev === null ? prev : { ...prev, [key]: next }));
  }

  let fields: ConfigFormFields<TValues> | null = null;
  if (values !== null) {
    const accessors = {} as ConfigFormFields<TValues>;
    for (const key of Object.keys(values) as (keyof TValues)[]) {
      accessors[key] = {
        value: values[key],
        set: (next) => setField(key, next),
      };
    }
    fields = accessors;
  }

  const dirty =
    values !== null && baseline !== null && !deepEqual(values, baseline);

  function reset() {
    setValues(baseline);
  }

  async function save(): Promise<MutateResult<TResponse>> {
    // Guard rather than throw: pages call save from event handlers where a
    // thrown error would escape to the console instead of the error surface.
    if (values === null || data === null) {
      return {
        ok: false,
        error: buildFetchError({
          message: "Settings haven't finished loading — try again in a moment.",
        }),
      };
    }
    const body = options.toPayload
      ? options.toPayload(values, data)
      : (values as Record<string, unknown>);
    return mutation.mutate({ body });
  }

  return {
    data,
    loading,
    loadError,
    refetch,
    fields,
    values,
    dirty,
    reset,
    save,
    saving: mutation.saving,
    error: mutation.error,
    clearError: mutation.clearError,
  };
}

/**
 * Structural equality over JSON-shaped form values (primitives, arrays,
 * plain objects). Local on purpose: the dirty compare is the hook's core
 * invariant and shouldn't drift with a general-purpose util's semantics.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const bArr = b as unknown[];
    return a.length === bArr.length && a.every((v, i) => deepEqual(v, bArr[i]));
  }
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  if (aKeys.length !== Object.keys(bRec).length) return false;
  return aKeys.every(
    (k) => Object.hasOwn(bRec, k) && deepEqual(aRec[k], bRec[k]),
  );
}
