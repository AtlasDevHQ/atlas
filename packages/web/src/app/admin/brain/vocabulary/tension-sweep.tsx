"use client";

import { useState } from "react";
import type { z } from "zod";
import { BrainFactTensionSweepResponseSchema } from "@/ui/lib/admin-schemas";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { sweepOutcome, sweepRefusal, type SweepOutcomeCopy } from "./sweep-report";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";

/**
 * **Look again** — the tension sweep, given a surface (#5447, #5029, ADR-0037 §7).
 *
 * ## Why this control lives on the VOCABULARY page
 *
 * The sweep is a `brain-facts` route and every other verb on that router names a
 * fact in its path. This one is workspace-scoped, and what arms it is a
 * vocabulary decision: approving an alias or a `single` cardinality entry changes
 * what WOULD collide for rows nothing will ever look at again, and replaying
 * reconciliation cannot reach the tension pass at all. So the operation belongs
 * beside the decision that creates the need for it — and the route's own 200
 * description sends the operator here anyway (*"check the vocabulary before
 * reading `0` as done"*), which is an instruction with nowhere to be followed
 * when the sweep is a `fetch` from a browser console.
 *
 * ## The whole panel is about not over-claiming
 *
 * Three states, and two of them are easy to render as a success they are not:
 *
 *   - `{minted: n}` — the only unambiguous one, and even it is qualified: the
 *     write is additive, so this is not an arbitration of anything.
 *   - `{minted: 0}` — **three facts wearing one number.** `sweep-report.ts` holds
 *     the argument and the three causes.
 *   - `{truncated: true}` — a bounded pass that stopped early. "Run it again"
 *     is its entire content, and it must not read as a failure.
 *
 * And the fourth state, which is not a state of the corpus at all: a 409, where
 * the sweep did not run. Its three arms are three different instructions, and
 * `sweepRefusal` is why they do not collapse into one.
 *
 * ## The refusal is rendered, and the button is not hidden
 *
 * The route re-resolves the owner/admin bar against the workspace being swept
 * rather than reading it off the session, so this page cannot know the answer
 * before asking. A control hidden on a guess would be a broken affordance for an
 * admin whose entitlement is fine and a silent one for an admin whose is not;
 * the server's own refusal prose, rendered where the button is, tells the second
 * one exactly what happened.
 */
export function TensionSweepPanel() {
  /**
   * The last completed run, or `null` for "not run in this page's lifetime".
   *
   * ⚠️ Kept apart from `error`, and CLEARED when a run refuses. A single slot
   * would leave the previous run's `minted: 3` on screen beside a 409 that
   * changed nothing — the failed-vs-empty conflation this admin area refuses
   * everywhere, in its most flattering direction.
   */
  const [report, setReport] = useState<SweepOutcomeCopy | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sweepMutation = useAdminMutation<
    z.infer<typeof BrainFactTensionSweepResponseSchema>
  >({ path: "/api/v1/admin/brain-facts/tension-sweep", method: "POST" });

  async function onSweep() {
    setError(null);
    setReport(null);
    const result = await sweepMutation.mutate({});
    if (!result.ok) {
      setError(sweepRefusal(result.error));
      return;
    }
    // ⚠️ PARSED, not trusted. `useAdminMutation` does `res.json() as TResponse`
    // with no validation — unlike `useAdminFetch`, it has no `schema` option — so
    // the import above was supplying a TYPE and nothing else, and this call site
    // was the one place that mattered: the numbers go straight into prose.
    //
    // A 2xx JSON body missing `minted` (a version-skewed API, a proxy answering
    // `{}` or `{"ok":true}` with a JSON content-type) is not `undefined`, so it
    // walked past the guard below: `minted === 0` was false, the non-zero branch
    // ran, and the panel rendered **"The sweep minted undefined advisory tension
    // edges."** under the neutral chrome — `unresolved` being `undefined` and
    // therefore falsy — beside clauses asserting nothing was superseded and that
    // re-running would not duplicate anything. A confident claim about a body
    // nobody read, which is this module's own named worst outcome.
    const parsed = BrainFactTensionSweepResponseSchema.safeParse(result.data);
    if (!parsed.success) {
      // One arm for "no body" and "a body that is not a report", because the
      // operator's position is identical in both: the run may have minted
      // anything, and `sweepOutcome({minted: 0})` would attribute a number to a
      // run that never reported one.
      setError(
        "The sweep returned no report this page can read, so what it did is unknown — read the " +
          "fact queue with its tension filter to see whether anything was flagged. Do not read " +
          "this as a run that minted nothing. If it persists, the API is likely newer than this " +
          "page.",
      );
      return;
    }
    setReport(sweepOutcome(parsed.data));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Look again for tensions</CardTitle>
        <CardDescription>
          Approving an alias or a single-valued predicate changes what <em>would</em> collide for
          claims nothing will ever look at again — and the ingest path only ever flags a tension for
          a claim it is creating. This is the operation that looks again over rows that already
          exist. It is additive and advisory: nothing is superseded, retracted or reordered.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error !== null ? (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {report !== null ? (
          // `unresolved` picks the chrome, so a zero and a truncated run do not
          // wear the neutral card that reads as "handled".
          <Alert variant={report.unresolved ? "destructive" : "default"}>
            {report.unresolved ? (
              <AlertTriangle className="size-4" aria-hidden />
            ) : (
              <Info className="size-4" aria-hidden />
            )}
            <AlertDescription>
              <span className="font-medium">{report.headline}</span>
              {report.clauses.map((clause) => (
                <p key={clause} className="mt-1.5 text-sm">
                  {clause}
                </p>
              ))}
            </AlertDescription>
          </Alert>
        ) : null}

        <div>
          <Button variant="outline" disabled={sweepMutation.saving} onClick={onSweep}>
            <RefreshCw className="mr-1.5 size-3.5" aria-hidden />
            {sweepMutation.saving ? "Sweeping…" : "Run the tension sweep"}
          </Button>
        </div>

        {/* Stated before the run, not only after a zero. An operator who has just
            authored a `single` entry and left it PENDING is the commonest caller,
            and telling them afterwards that a pending entry does not arm the
            sweep is telling them after they have read `0` as an answer. */}
        <p className="text-muted-foreground text-xs">
          Only an <strong>approved</strong> single-valued predicate arms this sweep — a pending
          proposal does not. Absent any curation nothing is minted, because <code>single</code>{" "}
          requires positive evidence.
        </p>
      </CardContent>
    </Card>
  );
}
