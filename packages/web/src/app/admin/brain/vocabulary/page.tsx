"use client";

import { useState } from "react";
import type { z } from "zod";
import type {
  BrainVocabularyBlastRadius,
  BrainVocabularyEdgeEntry,
  BrainVocabularySlotPosition,
  BrainVocabularySurfaceOption,
} from "@/ui/lib/types";
import {
  BrainVocabularyAuthorResponseSchema,
  BrainVocabularyInForceResponseSchema,
  BrainVocabularyPreviewResponseSchema,
  BrainVocabularyRemoveResponseSchema,
} from "@/ui/lib/admin-schemas";
import { BrainVocabularyPreviewRequestSchema } from "@/ui/lib/admin-schemas";
import { CoverageStatement } from "./coverage-statement";
import { BlastRadiusPreview } from "./blast-radius";
import { NormPicker, ScopeBadge } from "./norm-picker";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { AlertTriangle, ArrowRight, Trash2 } from "lucide-react";

/**
 * The preview body, typed from the SERVER's own schema.
 *
 * `Record<string, unknown>` compiled for a misspelled `fromNorm` and failed as a
 * 400 at runtime — on the one call whose result gates a workspace-wide re-key.
 * `z.input` is the SSOT rather than a hand-written mirror.
 */
type PreviewRequest = z.input<typeof BrainVocabularyPreviewRequestSchema>;

/** One preview's three states, kept together so they cannot drift apart. */
interface PreviewSlot {
  readonly radius: BrainVocabularyBlastRadius | null;
  readonly pending: boolean;
  readonly error: string | null;
}

const EMPTY_PREVIEW: PreviewSlot = { radius: null, pending: false, error: null };

const POSITIONS: readonly {
  value: BrainVocabularySlotPosition;
  label: string;
  hint: string;
}[] = [
  {
    value: "predicate",
    label: "Predicate",
    hint: "A relation — “is priced at”, “reports to”. Shown to every approver: a verb phrase discloses nothing you could not have guessed.",
  },
  {
    value: "subject",
    label: "Subject",
    hint: "An entity in the subject slot. Scoped to what you can read on both sides.",
  },
  {
    value: "object",
    label: "Object",
    hint: "An entity in the object slot. Scoped to what you can read on both sides.",
  },
];

/**
 * The **Claim Vocabulary** — direct authoring and what is in force
 * (#5087, ADR-0037 §6).
 *
 * ## Authoring is foregrounded, and the ordering is the argument
 *
 * The authoring card is first on the page, not a secondary button under an
 * empty table. The pending queue is empty on day one — the structural proposer
 * fires only on claims with comparable objects, and the cardinality proposer
 * needs three repeated corrections — while **authoring works immediately** and
 * is the only route by which some entries are ever written at all.
 *
 * A surface that buried authoring under an empty queue would put the one thing
 * this page can do on day one behind the one thing it cannot.
 *
 * ## Two panes, and the second one is why removal is recoverable
 *
 * *In force* lists approved edges and curated predicates, each removable behind
 * the same blast-radius preview an approval uses — a removal is a re-key too.
 * Without it, recovering from a bad alias means a database console at exactly
 * the moment it is needed.
 *
 * The Pending queue is a sibling slice and is not on this page yet. That is
 * stated in the copy rather than left as an absence, because a surface with no
 * queue and no explanation reads as a surface with nothing to review.
 */
export default function ClaimVocabularyPage() {
  return (
    <ErrorBoundary>
      <ClaimVocabulary />
    </ErrorBoundary>
  );
}

function ClaimVocabulary() {
  const [position, setPosition] = useState<BrainVocabularySlotPosition>("predicate");
  const [from, setFrom] = useState<BrainVocabularySurfaceOption | null>(null);
  const [to, setTo] = useState<BrainVocabularySurfaceOption | null>(null);
  const [authorError, setAuthorError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<BrainVocabularyEdgeEntry | null>(null);

  /**
   * ⚠️ TWO preview slots, not one shared one.
   *
   * A single `radius` looked like harmless reuse and was a cross-contamination
   * bug: clicking Remove on an in-force edge computed a REMOVAL radius into the
   * same state the authoring card renders — so the authoring card displayed a
   * preview for a decision nobody was making, and with both norms picked its
   * "Author this alias" button became enabled by it. The gate would have been
   * satisfied by a number computed for a different pair, in the opposite
   * direction, on a different verb.
   *
   * They are `authoring` and `removal` rather than one keyed slot because the
   * two are live at the same time — the dialog renders over the card — and a
   * keyed slot would still have to answer "whose is this?" at both call sites.
   */
  const [authorRadius, setAuthorRadius] = useState<PreviewSlot>(EMPTY_PREVIEW);
  const [removeRadius, setRemoveRadius] = useState<PreviewSlot>(EMPTY_PREVIEW);

  const {
    data: inForce,
    error: inForceError,
    loading: inForceLoading,
    refetch,
  } = useAdminFetch<z.infer<typeof BrainVocabularyInForceResponseSchema>>(
    "/api/v1/admin/brain-vocabulary/in-force",
    { schema: BrainVocabularyInForceResponseSchema },
  );

  const previewMutation = useAdminMutation<
    z.infer<typeof BrainVocabularyPreviewResponseSchema>
  >({ path: "/api/v1/admin/brain-vocabulary/preview", method: "POST" });
  const authorMutation = useAdminMutation<
    z.infer<typeof BrainVocabularyAuthorResponseSchema>
  >({ path: "/api/v1/admin/brain-vocabulary/author", method: "POST" });
  const removeMutation = useAdminMutation<
    z.infer<typeof BrainVocabularyRemoveResponseSchema>
  >({ path: "/api/v1/admin/brain-vocabulary/remove", method: "POST" });

  /**
   * Ask for one decision's blast radius.
   *
   * Shared by authoring and removal on purpose. The grill's *"a removal is a
   * re-key too"* is the whole reason the *In force* pane exists, and two preview
   * paths would be two places for the disclosure to drift from the transaction.
   */
  async function loadRadius(
    body: PreviewRequest,
    into: (slot: PreviewSlot) => void,
  ): Promise<void> {
    into({ radius: null, pending: true, error: null });
    const result = await previewMutation.mutate({ body });
    if (!result.ok) {
      into({ radius: null, pending: false, error: friendlyError(result.error) });
      return;
    }
    into({ radius: result.data?.radius ?? null, pending: false, error: null });
  }

  const bothPicked = from !== null && to !== null;

  async function onPreviewAuthoring() {
    if (!bothPicked) return;
    await loadRadius(
      { kind: "alias-approval", position, fromNorm: from.norm, toNorm: to.norm },
      setAuthorRadius,
    );
  }

  async function onAuthor() {
    if (!bothPicked) return;
    setAuthorError(null);
    setNotice(null);
    const result = await authorMutation.mutate({
      body: { position, fromNorm: from.norm, toNorm: to.norm },
    });
    if (!result.ok) {
      // The SERVER's prose, verbatim. Every refusal on this surface names which
      // side of a pair is empty, which norm already has a parent, or why a
      // removal is permanent — and a client that mapped a code to its own
      // sentence would be a second spelling of a rule the server owns.
      setAuthorError(friendlyError(result.error));
      return;
    }
    const data = result.data;
    setNotice(
      data?.outcome === "already_approved"
        ? `“${from.norm}” was already approved onto “${to.norm}”. Nothing changed.`
        : data?.convergedOnProposal
          ? `Authored: “${from.norm}” now resolves to “${to.norm}”. This decided a proposal a producer had already raised, so the audit trail records its source rather than direct authoring.`
          : `Authored: “${from.norm}” now resolves to “${to.norm}”. Every affected claim has been re-keyed.`,
    );
    setFrom(null);
    setTo(null);
    setAuthorRadius(EMPTY_PREVIEW);
    // Unawaited deliberately: `useAdminFetch` owns the refetch's own loading and
    // error state, so awaiting it here would only delay clearing the form. A
    // rejection surfaces through `inForceError`, which the page already renders.
    void refetch();
  }

  async function onConfirmRemove() {
    if (removeTarget === null) return;
    setNotice(null);
    const target = removeTarget;
    const result = await removeMutation.mutate({
      body: {
        position: target.position,
        fromNorm: target.fromNorm,
        toNorm: target.toNorm,
      },
    });
    if (!result.ok) {
      setAuthorError(friendlyError(result.error));
      setRemoveTarget(null);
      setRemoveRadius(EMPTY_PREVIEW);
      return;
    }
    setNotice(
      result.data?.outcome === "already_removed"
        ? `“${target.fromNorm}” → “${target.toNorm}” was already removed.`
        : `Removed: “${target.fromNorm}” no longer resolves to “${target.toNorm}”, and every affected claim has been re-keyed back.` +
          (result.data?.memoryCreated
            ? " This edge arrived from another region without a decision record, so Atlas wrote one — otherwise the next producer run would re-propose the pair."
            : ""),
    );
    setRemoveTarget(null);
    setRemoveRadius(EMPTY_PREVIEW);
    // Unawaited deliberately — see `onAuthor`.
    void refetch();
  }

  const edges = inForce?.edges ?? [];
  const cardinalities = inForce?.cardinalities ?? [];
  const counts = inForce?.counts ?? [];
  const positionMeta = POSITIONS.find((p) => p.value === position);
  // `null`, never `?? "unscoped"`. A missing counts entry — which is what the
  // load-failure path produces — would otherwise make the page assert
  // WORKSPACE-WIDE visibility on the strength of an absent value, which is the
  // fail-open reflex this whole surface refuses everywhere else.
  const positionScope = counts.find((c) => c.position === position)?.scope ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Vocabulary</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Which spellings Atlas treats as naming the same thing, and which relations hold only one
          value at a time. Both change what corroborates, what contradicts, and what replaces what
          — across every claim in the workspace, retroactively.
        </p>
      </div>

      {inForceError !== null ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertDescription>
            What is in force could not be loaded, so this page cannot tell you what is shaping
            identity right now. {friendlyError(inForceError)}
          </AlertDescription>
        </Alert>
      ) : null}

      {notice !== null ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {/* Coverage first, and never a congratulation. See coverage-statement.tsx. */}
      {inForce !== null && inForce !== undefined ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where this workspace stands</CardTitle>
          </CardHeader>
          <CardContent>
            <CoverageStatement
              coverage={inForce.coverage}
              counts={counts}
              edgeCount={edges.length}
              cardinalityCount={cardinalities.length}
              cardinalityCounts={inForce.cardinalityCounts}
            />
          </CardContent>
        </Card>
      ) : null}

      {/* AUTHORING, foregrounded — not a secondary button under an empty table. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Author an alias</CardTitle>
          <CardDescription>
            Merge two spellings that name the same thing. Both sides are picked from what your
            corpus actually contains — an alias for a spelling Atlas has never recorded inserts
            cleanly and changes nothing, which looks exactly like success.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <span className="text-sm font-medium">Position</span>
            <Select
              value={position}
              onValueChange={(next) => {
                // Narrowed, not cast. `POSITIONS` is the page's own list, so a
                // value outside it is a shadcn contract break rather than user
                // input — but a cast here would also swallow a typo in the list
                // itself, and the picker would then query a position the API
                // refuses with a 400 nobody could explain.
                const picked = POSITIONS.find((p) => p.value === next);
                if (picked === undefined) return;
                setPosition(picked.value);
                setFrom(null);
                setTo(null);
                setAuthorRadius(EMPTY_PREVIEW);
                setAuthorError(null);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POSITIONS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{positionMeta?.hint}</p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <NormPicker
              position={position}
              label="Merge this spelling…"
              value={from}
              onChange={(next) => {
                setFrom(next);
                setAuthorRadius(EMPTY_PREVIEW);
              }}
              excludeNorm={to?.norm}
            />
            <NormPicker
              position={position}
              label="…into this one"
              value={to}
              onChange={(next) => {
                setTo(next);
                setAuthorRadius(EMPTY_PREVIEW);
              }}
              excludeNorm={from?.norm}
            />
          </div>

          {bothPicked ? (
            <div className="border-border rounded-md border px-3 py-2 text-sm">
              <span className="font-mono">{from.norm}</span>
              <ArrowRight className="mx-2 inline size-3.5" aria-hidden />
              <span className="font-mono">{to.norm}</span>
              <p className="text-muted-foreground mt-1 text-xs">
                Every claim whose {position} folds to “{from.norm}” will be re-keyed onto “
                {to.norm}”, and every future one will be too. This is reversible: removing the
                alias re-keys them back.
              </p>
            </div>
          ) : null}

          <BlastRadiusPreview
            radius={authorRadius.radius}
            pending={authorRadius.pending}
            error={authorRadius.error}
          />

          {authorError !== null ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" aria-hidden />
              <AlertDescription>{authorError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!bothPicked || authorRadius.pending}
              onClick={onPreviewAuthoring}
            >
              Preview the impact
            </Button>
            <Button
              disabled={!bothPicked || authorMutation.saving || authorRadius.radius === null}
              onClick={onAuthor}
            >
              Author this alias
            </Button>
          </div>
          {bothPicked && authorRadius.radius === null ? (
            <p className="text-muted-foreground text-xs">
              Preview first. This decision re-keys every affected claim in the workspace, so the
              blast radius is not optional.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* IN FORCE. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">In force</CardTitle>
          <CardDescription>
            What is shaping identity right now. Removing an entry is a re-key too, so it goes
            behind the same preview.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {counts.map((c) => (
              <div
                key={c.position}
                className="border-border flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
              >
                <span className="font-medium capitalize">{c.position}</span>
                <span className="text-muted-foreground">
                  {c.scoped} of {c.total}
                </span>
                <ScopeBadge scope={c.scope} />
                {/* ⚠️ A withheld count, never a silent omission: "12 you cannot
                    see" and "none" are opposite facts that a scoped list
                    renders identically. */}
                {c.withheld > 0 ? (
                  <Badge variant="outline">{c.withheld} withheld</Badge>
                ) : null}
                {!c.countsConsistent ? (
                  <Badge variant="destructive">counts disagreed</Badge>
                ) : null}
              </div>
            ))}
          </div>

          <Separator />

          {inForceError !== null ? (
            // ⚠️ NOT "no alias edges are in force". The list falls back to `[]`
            // on failure, so the flat sentence would state the workspace has
            // none at the moment nobody knows what it has — the exact
            // failed-vs-empty conflation `NormPicker` already refuses, and the
            // one this whole surface exists to prevent.
            <p className="text-muted-foreground text-sm">
              What is in force could not be loaded, so this list is empty because the request
              failed — not because your workspace has nothing in force.
            </p>
          ) : inForceLoading ? (
            <p className="text-muted-foreground text-sm">Loading what is in force…</p>
          ) : edges.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No alias edges are in force
              {counts.some((c) => c.withheld > 0) ? " that you can see" : ""}.
            </p>
          ) : (
            <ul className="border-border divide-border divide-y rounded-md border">
              {edges.map((edge) => (
                <li
                  key={`${edge.position}:${edge.fromNorm}`}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm">
                      <span className="font-mono">{edge.fromNorm}</span>
                      <ArrowRight className="mx-2 inline size-3.5" aria-hidden />
                      <span className="font-mono">{edge.toNorm}</span>
                    </div>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      <span className="capitalize">{edge.position}</span> ·{" "}
                      {edge.approvedBy === null
                        ? "auto-approved from a warehouse key"
                        : `approved by ${edge.approvedBy}`}
                      {edge.hasRejectionMemory ? "" : " · imported without a decision record"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setRemoveTarget(edge);
                      setAuthorError(null);
                      void loadRadius(
                        {
                          kind: "alias-removal",
                          position: edge.position,
                          fromNorm: edge.fromNorm,
                        },
                        setRemoveRadius,
                      );
                    }}
                  >
                    <Trash2 className="mr-1.5 size-3.5" aria-hidden />
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {cardinalities.length > 0 ? (
            <>
              <Separator />
              <div>
                <h3 className="mb-2 text-sm font-medium">Curated predicates</h3>
                <ul className="border-border divide-border divide-y rounded-md border">
                  {cardinalities.map((entry, index) => (
                    <li
                      key={`${entry.predicateSurface ?? "unknown"}:${index}`}
                      className="px-3 py-2 text-sm"
                    >
                      <span className="font-mono">
                        {entry.predicateSurface ?? "(no live claim carries this predicate)"}
                      </span>{" "}
                      <Badge variant="secondary">{entry.cardinality}</Badge>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {entry.claims} live {entry.claims === 1 ? "claim" : "claims"} · recorded by{" "}
                        {entry.proposedBy || "an unnamed author"}
                        {entry.cardinality === "single"
                          ? " · every future claim in this slot can supersede an earlier one"
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : null}

          {inForce?.truncated ? (
            <p className="text-muted-foreground text-xs">
              More entries are in force than are listed here.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* The absent queue, STATED. A page with no queue and no explanation
          reads as a page with nothing to review — the same false all-clear the
          empty state exists to avoid, one level up. */}
      <p className="text-muted-foreground text-xs">
        Proposals raised by Atlas itself — spellings that agree structurally, and predicates
        corrected the same way three times — get their own review queue in a later release. This
        page is authoring and what is already in force. Position: {position} (
        {positionScope ?? "scope unknown"}).
      </p>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
          setRemoveTarget(null);
          setRemoveRadius(EMPTY_PREVIEW);
        }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this alias?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  “{removeTarget?.fromNorm}” will stop resolving to “{removeTarget?.toNorm}”, and
                  every affected claim will be re-keyed back. Any alias this one was hiding will
                  take effect again.
                </p>
                <p>
                  Atlas remembers the removal permanently, so its own producers will not re-propose
                  this pair — and neither can you re-author it from this page.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-6">
            <BlastRadiusPreview
              radius={removeRadius.radius}
              pending={removeRadius.pending}
              error={removeRadius.error}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {/* NOT `AlertDialogAction`: that closes the dialog on click, which
                would tear down the blast-radius panel and the error surface at
                the moment either has something to say. */}
            {/* Gated on a SUCCESSFUL preview, exactly as authoring is. The
                earlier spelling checked only `radiusPending`, so the button
                stayed live beside "the blast radius could not be computed …
                unknown — not zero" — on the graver of the two verbs, which
                re-keys the corpus back and writes permanent rejection memory. */}
            <Button
              variant="destructive"
              disabled={
                removeMutation.saving ||
                removeRadius.pending ||
                removeRadius.radius === null ||
                removeRadius.error !== null
              }
              onClick={onConfirmRemove}
            >
              Remove the alias
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
