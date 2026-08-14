"use client";

import { useState } from "react";
import type { z } from "zod";
import type { BrainEnrollmentEntry } from "@/ui/lib/types";
import {
  BrainEnrollmentDimensionsResponseSchema,
  BrainEnrollmentEntitiesResponseSchema,
  BrainEnrollmentListResponseSchema,
  BrainEnrollmentWriteResponseSchema,
} from "@/ui/lib/admin-schemas";
import { useAdminFetch } from "@/ui/hooks/use-admin-fetch";
import { useAdminMutation } from "@/ui/hooks/use-admin-mutation";
import { friendlyError } from "@/ui/lib/fetch-error";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBoundary } from "@/ui/components/error-boundary";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";

type ListResponse = z.infer<typeof BrainEnrollmentListResponseSchema>;
type EntitiesResponse = z.infer<typeof BrainEnrollmentEntitiesResponseSchema>;
type DimensionsResponse = z.infer<typeof BrainEnrollmentDimensionsResponseSchema>;
type WriteResponse = z.infer<typeof BrainEnrollmentWriteResponseSchema>;

/**
 * **Enrollment** — what the warehouse producer may hold claims about
 * (#5196, ADR-0039).
 *
 * ## The page is a picker, and that is the design rather than the styling
 *
 * ADR-0039's rejected-alternative test is *"whether a person chose the members,
 * not whether a person clicked something."* A free-text pair box would satisfy
 * "a person typed it" and fail that test in the direction that matters — it
 * makes a typo indistinguishable from a working enrollment, because a pair the
 * producer never matches sits in the list looking live. So both halves are
 * picked from the published semantic layer, and the server re-checks the pair
 * before it writes.
 *
 * ## There is no "enroll everything" button, deliberately
 *
 * Not an omission and not a to-do. A bulk affordance over a set the SERVER chose
 * is the sweep this whole surface exists instead of; one over a selection an
 * admin ticked would be enrollment and could be added. If a future version grows
 * a bulk control, the question to ask is which of those two it is.
 *
 * ## Three states this page refuses to conflate
 *
 * - **enrolled nothing** vs **could not load what is enrolled** — the second
 *   renders as a failure, never as an empty list.
 * - **no entities in the semantic layer** vs **could not read it** — same split,
 *   on its own fetch, which is why the two lists are two requests.
 * - **un-enrolled** vs **retracted** — the removal copy says what un-enrolling
 *   does NOT do, because "stop holding claims about this" is what an admin will
 *   read the button as meaning.
 */
export default function BrainEnrollmentPage() {
  return (
    <ErrorBoundary>
      <BrainEnrollment />
    </ErrorBoundary>
  );
}

function BrainEnrollment() {
  const [entity, setEntity] = useState<string | null>(null);
  const [dimension, setDimension] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const {
    data: list,
    error: listError,
    loading: listLoading,
    refetch,
  } = useAdminFetch<ListResponse>("/api/v1/admin/brain-enrollment", {
    schema: BrainEnrollmentListResponseSchema,
  });

  const {
    data: entities,
    error: entitiesError,
    loading: entitiesLoading,
  } = useAdminFetch<EntitiesResponse>("/api/v1/admin/brain-enrollment/entities", {
    schema: BrainEnrollmentEntitiesResponseSchema,
  });

  /**
   * The dimension list re-fetches when the picked entity changes, and is
   * DISABLED until one is picked.
   *
   * `enabled` rather than an empty path: an unconditional request would fire
   * with no `entity` query param, which the route answers 400 — an error banner
   * on a page nobody has interacted with yet.
   *
   * It also depends on `list` so the `enrolled` flags refresh after a write.
   * That flag is computed server-side against the same rows the list endpoint
   * returns, so re-deriving it here would be a second spelling of the pair's
   * identity — and a mismatch renders an enrolled pair as un-enrolled, which is
   * an offer whose click is a silent no-op.
   */
  const {
    data: dimensions,
    error: dimensionsError,
    loading: dimensionsLoading,
  } = useAdminFetch<DimensionsResponse>(
    entity === null ? "" : `/api/v1/admin/brain-enrollment/dimensions?entity=${encodeURIComponent(entity)}`,
    {
      schema: BrainEnrollmentDimensionsResponseSchema,
      enabled: entity !== null,
      deps: [entity, list],
    },
  );

  const enrollMutation = useAdminMutation<WriteResponse>({
    path: "/api/v1/admin/brain-enrollment/enroll",
    method: "POST",
  });
  const unenrollMutation = useAdminMutation<WriteResponse>({
    path: "/api/v1/admin/brain-enrollment/unenroll",
    method: "POST",
  });

  const enrollments = list?.enrollments ?? [];
  const entityOptions = entities?.entities ?? [];
  const dimensionOptions = dimensions?.dimensions ?? [];
  const picked = dimensionOptions.find((d) => d.name === dimension) ?? null;
  const canEnroll = entity !== null && picked !== null && !picked.enrolled;

  async function onEnroll() {
    if (entity === null || dimension === null) return;
    setWriteError(null);
    setNotice(null);
    const result = await enrollMutation.mutate({
      body: { entity, dimension, note: note.trim() === "" ? null : note.trim() },
    });
    if (!result.ok) {
      // The SERVER's prose, verbatim. Every refusal on this surface names which
      // half of the pair is unknown, or why the caller is not entitled — and a
      // client that mapped a code to its own sentence would be a second spelling
      // of a rule the server owns.
      setWriteError(friendlyError(result.error));
      return;
    }
    setNotice(
      result.data?.changed === false
        ? `“${entity} / ${dimension}” was already enrolled. Nothing changed — the recorded author and note are whoever enrolled it first.`
        : `Enrolled: Atlas may now hold claims about “${entity} / ${dimension}”. Every claim the producer emits still arrives as a draft and still needs your review.`,
    );
    setDimension(null);
    setNote("");
    // Unawaited deliberately: `useAdminFetch` owns the refetch's own loading and
    // error state, so awaiting it here would only delay clearing the form. A
    // rejection surfaces through `listError`, which the page already renders.
    void refetch();
  }

  async function onUnenroll(target: BrainEnrollmentEntry) {
    setWriteError(null);
    setNotice(null);
    const result = await unenrollMutation.mutate({
      itemId: `${target.entity}/${target.dimension}`,
      body: { entity: target.entity, dimension: target.dimension },
    });
    if (!result.ok) {
      setWriteError(friendlyError(result.error));
      return;
    }
    setNotice(
      result.data?.changed === false
        ? `“${target.entity} / ${target.dimension}” was not enrolled.`
        : `Removed: the producer will not emit new claims about “${target.entity} / ${target.dimension}”. Claims it already emitted and you already published are untouched — still published, still visible, still valid.`,
    );
    void refetch();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Enrollment</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Which parts of your warehouse Atlas may hold claims about. Connecting a datasource already
          lets Atlas query it; this decides what it remembers. Anything not enrolled is outside the
          producer’s reach — not hidden, not filtered, not waiting.
        </p>
      </div>

      {listError !== null ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertDescription>
            What is enrolled could not be loaded, so this page cannot tell you what Atlas is allowed
            to learn right now. {friendlyError(listError)}
          </AlertDescription>
        </Alert>
      ) : null}

      {notice !== null ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {/* ENROLL — first, because the list is empty on day one and this is not. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Enroll a dimension</CardTitle>
          <CardDescription>
            Both halves are picked from your published semantic layer, so a pair Atlas cannot see can
            never be enrolled — one would store cleanly, reach nothing, and look exactly like
            success.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <span className="text-sm font-medium">Entity</span>
              {entitiesError !== null ? (
                // ⚠️ NOT "no entities". The list falls back to `[]` on failure,
                // so the flat sentence would state the workspace has no semantic
                // layer at the moment nobody knows what it has.
                <p className="text-destructive text-xs">
                  Your semantic layer could not be read, so this list is empty because the request
                  failed — not because there is nothing to enroll. {friendlyError(entitiesError)}
                </p>
              ) : (
                <Select
                  value={entity ?? undefined}
                  onValueChange={(next) => {
                    setEntity(next);
                    setDimension(null);
                    setWriteError(null);
                  }}
                  disabled={entitiesLoading || entityOptions.length === 0}
                >
                  <SelectTrigger className="w-full" aria-label="Entity">
                    <SelectValue
                      placeholder={
                        entitiesLoading
                          ? "Loading your semantic layer…"
                          : entityOptions.length === 0
                            ? "No published entities yet"
                            : "Pick an entity"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {entityOptions.map((option) => (
                      <SelectItem key={option.name} value={option.name}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {entitiesError === null && !entitiesLoading && entityOptions.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  Nothing is published in your semantic layer, so there is nothing to enroll yet.
                  Publish an entity first.
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <span className="text-sm font-medium">Dimension or measure</span>
              {dimensionsError !== null ? (
                <p className="text-destructive text-xs">
                  That entity’s dimensions could not be read. {friendlyError(dimensionsError)}
                </p>
              ) : (
                <Select
                  value={dimension ?? undefined}
                  onValueChange={(next) => {
                    setDimension(next);
                    setWriteError(null);
                  }}
                  disabled={entity === null || dimensionsLoading || dimensionOptions.length === 0}
                >
                  <SelectTrigger className="w-full" aria-label="Dimension or measure">
                    <SelectValue
                      placeholder={
                        entity === null
                          ? "Pick an entity first"
                          : dimensionsLoading
                            ? "Loading…"
                            : dimensionOptions.length === 0
                              ? "That entity declares none"
                              : "Pick a dimension"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {dimensionOptions.map((option) => (
                      <SelectItem key={option.name} value={option.name}>
                        {option.name}
                        {option.kind === "measure" ? " (measure)" : ""}
                        {option.enrolled ? " — already enrolled" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {picked?.description !== null && picked?.description !== undefined ? (
                <p className="text-muted-foreground text-xs">{picked.description}</p>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-sm font-medium">Why (optional)</span>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What this pair is worth remembering for"
              maxLength={500}
              aria-label="Why this pair is worth holding claims about"
            />
          </div>

          {picked?.enrolled === true ? (
            <p className="text-muted-foreground text-xs">
              “{entity} / {dimension}” is already enrolled. Re-enrolling would change nothing,
              including the recorded author.
            </p>
          ) : null}

          {writeError !== null ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" aria-hidden />
              <AlertDescription>{writeError}</AlertDescription>
            </Alert>
          ) : null}

          <Button disabled={!canEnroll || enrollMutation.saving} onClick={onEnroll}>
            <Plus className="mr-1.5 size-3.5" aria-hidden />
            Enroll this dimension
          </Button>
        </CardContent>
      </Card>

      {/* IN REACH. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">In the producer’s reach</CardTitle>
          <CardDescription>
            Atlas may hold claims about these pairs and no others. Everything it produces still
            arrives as a draft for your review — enrolling decides what may be proposed, never what
            is true.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2 text-xs">
            <div className="border-border flex items-center gap-2 rounded-md border px-2 py-1">
              <span className="font-medium">Pairs</span>
              <span className="text-muted-foreground">{enrollments.length}</span>
            </div>
            <div className="border-border flex items-center gap-2 rounded-md border px-2 py-1">
              <span className="font-medium">Entities</span>
              {/* The SERVER's number, not `new Set(...)` over the rows. It is the
                  set the producer evaluates its ambiguity rule across, and a
                  client-side count would be a second spelling of it. */}
              <span className="text-muted-foreground">{list?.entityCount ?? 0}</span>
            </div>
          </div>

          <Separator />

          {listError !== null ? (
            <p className="text-muted-foreground text-sm">
              What is enrolled could not be loaded, so this list is empty because the request failed
              — not because your workspace has enrolled nothing.
            </p>
          ) : listLoading ? (
            <p className="text-muted-foreground text-sm">Loading what is enrolled…</p>
          ) : enrollments.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing is enrolled, so the warehouse producer will not emit a single claim. That is
              the starting state, not a fault — Atlas can still query your warehouse live.
            </p>
          ) : (
            <ul className="border-border divide-border divide-y rounded-md border">
              {enrollments.map((entry) => (
                <li
                  key={`${entry.entity}/${entry.dimension}`}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm">
                      <span className="font-mono">{entry.entity}</span>
                      <span className="text-muted-foreground mx-1.5">/</span>
                      <span className="font-mono">{entry.dimension}</span>
                    </div>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      enrolled by {entry.enrolledBy}
                      {entry.note !== null ? ` · ${entry.note}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {unenrollMutation.errorFor(`${entry.entity}/${entry.dimension}`) !==
                    undefined ? (
                      <Badge variant="destructive">not removed</Badge>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={unenrollMutation.isMutating(`${entry.entity}/${entry.dimension}`)}
                      onClick={() => onUnenroll(entry)}
                    >
                      <Trash2 className="mr-1.5 size-3.5" aria-hidden />
                      Un-enroll
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* ⚠️ Stated on the page, not only in the code. "Un-enroll" reads as
              "stop knowing this", and an admin who believed that would use this
              button to try to retract a published claim. */}
          <p className="text-muted-foreground text-xs">
            Un-enrolling stops future claims and nothing else. Claims Atlas already produced and you
            already published stay published and stay visible — retracting one is a decision you
            make on the claim itself, in Facts.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
