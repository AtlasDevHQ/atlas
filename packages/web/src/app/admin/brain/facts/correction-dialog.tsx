"use client";

import { useState } from "react";
import type { BrainFactCandidate } from "@/ui/lib/types";
import { canSupersede, type CorrectionIntent } from "./claim-correction";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { AlertTriangle } from "lucide-react";

/**
 * The correction dialog — where a human says what happened to a claim (#5426).
 *
 * ## Two dialogs, one component, and the split is the point
 *
 * On a DRAFT row this is today's rejection confirmation, unchanged: one
 * sentence and one destructive button. A candidate under review was never true,
 * so *"it was true and then it changed"* is not a thing that can have happened
 * to it — and the API agrees, refusing `supersede` on any unpublished target
 * (`TARGET_NOT_PUBLISHED`). The draft queue is the default chip and where the
 * reviewer spends their time; taxing it to serve a case it cannot contain is
 * how this change would make review worse.
 *
 * On a PUBLISHED row with an open window — {@link canSupersede}, the one row
 * state that admits both verbs — it asks the question instead.
 *
 * ## The copy never says `retract` or `supersede`
 *
 * Condition 5 asks that a human correcting an outdated claim gets there
 * *"without needing to know either word"*. The verbs are an implementation
 * vocabulary; the human is asked what happened, and `claim-correction.ts` maps
 * the answer. Anything here that named a verb would be the leak.
 *
 * ## Asymmetric on purpose
 *
 * The supersede option is absent where it is inadmissible, not present and
 * disabled. A disabled control on every draft row teaches the shape of the
 * record at the cost of putting a dead affordance in the reviewer's way on the
 * common path — and this must never read as *"supersede is the good verb"*.
 * Withdrawal stays exactly as easy as it was.
 */
export function CorrectionDialog({
  target,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: {
  readonly target: BrainFactCandidate | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (intent: CorrectionIntent) => void;
}) {
  const [kind, setKind] = useState<CorrectionIntent["kind"]>("never-true");
  const [object, setObject] = useState("");
  const [since, setSince] = useState("");

  const offersChange = target !== null && canSupersede(target);

  function reset() {
    setKind("never-true");
    setObject("");
    setSince("");
  }

  function submit() {
    if (!target) return;
    onSubmit(
      kind === "changed"
        ? { kind: "changed", object, since: since || null, reason: null }
        : { kind: "never-true", reason: null },
    );
  }

  const claim = target ? `${target.subject} ${target.predicate} ${target.object}` : "";
  // The affirmative arm needs a value; the withdrawal arm never does. Gating
  // here rather than only in `correctionBody` means the button is visibly
  // unavailable instead of failing on press.
  const incomplete = kind === "changed" && object.trim() === "";

  return (
    <AlertDialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) reset();
        onOpenChange(open);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {offersChange ? "What happened to this claim?" : "Reject this claim?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {offersChange ? (
              <>&ldquo;{claim}&rdquo; is published and Atlas answers with it today.</>
            ) : (
              <>
                &ldquo;{claim}&rdquo; will be withdrawn. It leaves this queue and is never
                published. Nothing is deleted — the claim stays on the record, so questions about
                what Atlas believed in the past still answer correctly.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {offersChange && (
          <RadioGroup
            value={kind}
            onValueChange={(v) => setKind(v as CorrectionIntent["kind"])}
            className="gap-3"
          >
            <div className="flex gap-3">
              <RadioGroupItem value="never-true" id="correction-never-true" className="mt-1" />
              <Label htmlFor="correction-never-true" className="font-normal leading-snug">
                <span className="font-medium">It shouldn&rsquo;t be here.</span>{" "}
                <span className="text-muted-foreground">
                  It was never true, or it should not have been published. Atlas stops answering
                  with it, and stops offering it as history.
                </span>
              </Label>
            </div>

            <div className="flex gap-3">
              <RadioGroupItem value="changed" id="correction-changed" className="mt-1" />
              <Label htmlFor="correction-changed" className="font-normal leading-snug">
                <span className="font-medium">It was true — it changed.</span>{" "}
                <span className="text-muted-foreground">
                  Atlas answers with the new value, and can still say what it used to be and who
                  changed it.
                </span>
              </Label>
            </div>
          </RadioGroup>
        )}

        {offersChange && kind === "changed" && (
          <div className="grid gap-3 rounded-md border p-3">
            <div className="grid gap-1.5">
              <Label htmlFor="correction-object">
                {target?.subject} {target?.predicate} …
              </Label>
              <Input
                id="correction-object"
                value={object}
                autoFocus
                placeholder={target?.object}
                onChange={(e) => setObject(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="correction-since">Since when? (optional)</Label>
              <Input
                id="correction-since"
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                When the new value started being true. Leave blank and Atlas records it as
                changing now.
              </p>
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            // Not destructive styling when the human said the claim CHANGED —
            // that arm publishes a replacement and preserves the old value, so
            // dressing it as a deletion would misdescribe what the button does.
            className={
              kind === "changed"
                ? undefined
                : "bg-destructive text-destructive-foreground hover:bg-destructive/90"
            }
            disabled={busy || incomplete}
            // preventDefault stops Radix auto-closing: a failed correction must
            // keep the dialog open to show why, and the caller closes it itself
            // only on success.
            onClick={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {kind === "changed" ? "Save new value" : "Reject"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
