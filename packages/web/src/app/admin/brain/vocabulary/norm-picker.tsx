"use client";

import { useState } from "react";
import type { z } from "zod";
import type {
  BrainVocabularyScope,
  BrainVocabularySlotPosition,
  BrainVocabularySurfaceOption,
} from "@/ui/lib/types";
import { BrainVocabularySurfaceListSchema } from "@/ui/lib/admin-schemas";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { friendlyError } from "@/ui/lib/fetch-error";
import { AlertTriangle, Check, Search } from "lucide-react";

/**
 * Pick one norm from the surfaces the corpus has actually produced.
 *
 * ## ⚠️ This is a picker and it must never become a text box
 *
 * An alias is a pair of NORMS, and normalization is ASCII-only case folding with
 * a specific separator class. A human typing `499 a month` vs `499 A Month` vs
 * `499-a-month` cannot reliably predict what the pipeline produced — and a wrong
 * guess authors an edge whose source norm **no fact has ever produced**. It
 * inserts cleanly, the closure recomputes, the re-key moves zero rows, and the
 * preview reads 0. Every signal on this page says *success*.
 *
 * That failure lands exactly where it hurts most: direct authoring is the only
 * route by which the arc's originating entry is ever written, because the
 * structural proposer provably cannot propose it. So the one path to closing
 * that bug is also the one whose failure mode is indistinguishable from success.
 *
 * The text field here **filters**. It never supplies a value: `value` is only
 * ever set from a row the server returned, and the parent submits `value`.
 *
 * ## The resolved norm is DISPLAYED
 *
 * Each row shows the norm beside the surface that produced it and how many
 * spellings fold into it, so the merge is visible before it is decided. A row
 * reading *"priced at · 3 spellings · 41 claims"* is the evidence that folding
 * happened at all — which is the reason a human cannot be asked to predict it.
 */
export function NormPicker({
  position,
  label,
  value,
  onChange,
  excludeNorm,
}: {
  position: BrainVocabularySlotPosition;
  label: string;
  value: BrainVocabularySurfaceOption | null;
  onChange: (option: BrainVocabularySurfaceOption | null) => void;
  /** The other side's norm, so a self-edge cannot be assembled by clicking. */
  excludeNorm?: string;
}) {
  // Local draft, submitted rather than sent per keystroke — the queue page's
  // trade, for its reason: the corpus can be large and the filter should carry
  // a term the approver meant rather than every prefix of it.
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");

  const query = new URLSearchParams({ position });
  if (filter !== "") query.set("q", filter);

  const { data, loading, error } = useAdminFetch<
    z.infer<typeof BrainVocabularySurfaceListSchema>
  >(`/api/v1/admin/brain-vocabulary/surfaces?${query.toString()}`, {
    schema: BrainVocabularySurfaceListSchema,
  });

  const options = (data?.surfaces ?? []).filter((o) => o.norm !== excludeNorm);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{label}</span>
        {value !== null ? (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Change
          </Button>
        ) : null}
      </div>

      {value !== null ? (
        <div className="border-border bg-muted/40 rounded-md border px-3 py-2">
          <div className="flex items-center gap-2">
            <Check className="text-foreground size-4 shrink-0" aria-hidden />
            <span className="font-mono text-sm">{value.norm}</span>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            {describeOption(value)}
          </p>
        </div>
      ) : (
        <>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setFilter(draft.trim());
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Filter the list…"
              aria-label={`Filter ${label} options`}
            />
            <Button type="submit" variant="outline" size="icon" aria-label="Apply filter">
              <Search className="size-4" aria-hidden />
            </Button>
          </form>
          {/* Stated in the UI, not only in this file's header. An approver who
              believes the box is an input will type a norm and wonder why
              nothing matches. */}
          <p className="text-muted-foreground text-xs">
            This filters the list below. Pick a value from it — typing a spelling here never
            supplies one, because case and separator folding means the spelling you expect is often
            not the one Atlas recorded.
          </p>

          {error !== null ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" aria-hidden />
              <AlertDescription>
                The observed {position} values could not be loaded, so this list is empty because
                the request failed — not because your workspace has none.{" "}
                {friendlyError(error)}
              </AlertDescription>
            </Alert>
          ) : loading ? (
            <p className="text-muted-foreground text-sm">Loading observed {position} values…</p>
          ) : options.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {filter === ""
                ? `No live claim in this workspace carries a ${position} you can read. There is nothing to alias here yet.`
                : `No observed ${position} matches “${filter}”. Clear the filter to see what is there.`}
            </p>
          ) : (
            <ul className="border-border divide-border max-h-64 divide-y overflow-y-auto rounded-md border">
              {options.map((option) => (
                <li key={option.norm}>
                  <button
                    type="button"
                    className="hover:bg-muted/60 w-full px-3 py-2 text-left"
                    onClick={() => onChange(option)}
                  >
                    <span className="font-mono text-sm">{option.norm}</span>
                    <span className="text-muted-foreground ml-2 text-xs">
                      {describeOption(option)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {data?.truncated ? (
            <p className="text-muted-foreground text-xs">
              This workspace has more {position} values than are listed. Filter to find yours —
              their absence from this page does not mean they do not exist.
            </p>
          ) : null}

          {data?.scope === "reader-scoped" ? (
            <p className="text-muted-foreground text-xs">
              Entity positions are scoped to what you can read, so this list may be smaller than
              the workspace's.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** `"is priced at" · 3 spellings · 41 claims` — the merge, made visible. */
function describeOption(option: BrainVocabularySurfaceOption): string {
  const spellings =
    option.variants > 1 ? `${option.variants} spellings, e.g. “${option.exampleSurface}”` : `“${option.exampleSurface}”`;
  return `${spellings} · ${option.claims} live ${option.claims === 1 ? "claim" : "claims"}`;
}

/**
 * The scope badge the pane renders beside a position.
 *
 * ⚠️ The unknown case renders "scope unknown", NOT "workspace-wide". The prop
 * used to be `string` with `workspace-wide` as the fallthrough — so an
 * unrecognised value rendered the most reassuring badge on the page, which says
 * *nothing is hidden from you*: precisely the sentence `withheldCount` and
 * `logFailClosedHole` exist to prevent, reintroduced by a default.
 *
 * Typing the prop is what makes the exhaustive `switch` possible, so a new arm
 * on the wire union is a compile error here rather than a silent downgrade to
 * the permissive badge. `null` is accepted for the caller that genuinely has no
 * counts entry (a failed load) and needs to say so.
 */
export function ScopeBadge({ scope }: { scope: BrainVocabularyScope | null }) {
  switch (scope) {
    case "reader-scoped":
      return <Badge variant="outline">scoped to you</Badge>;
    case "deny-all":
      return <Badge variant="destructive">nothing visible</Badge>;
    case "unscoped":
      return <Badge variant="secondary">workspace-wide</Badge>;
    case null:
      return <Badge variant="outline">scope unknown</Badge>;
    default: {
      // An arm the wire union grew and this page has not learned. Rendered as
      // unknown rather than as workspace-wide, for the reason above.
      const unrecognised: never = scope;
      void unrecognised;
      return <Badge variant="outline">scope unknown</Badge>;
    }
  }
}
