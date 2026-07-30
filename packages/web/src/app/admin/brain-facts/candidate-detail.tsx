"use client";

import type {
  BrainFactCandidate,
  BrainFactDecayView,
  BrainFactProvenanceView,
  BrainFactTensionView,
} from "@/ui/lib/types";
import { Badge } from "@/components/ui/badge";
import { RelativeTimestamp } from "@/ui/components/admin/queue";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Clock, ShieldAlert, Split } from "lucide-react";
import { blockedBadge, decayBadge, provisionalBadge, statusBadge } from "./columns";

/**
 * The body of the review sheet — everything behind the trust call for one
 * claim.
 *
 * Presentation only: it renders what the read model attached and offers no
 * verdict of its own. The reviewer's two actions (retract, or publish the
 * queue) live on the page, not here.
 */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="text-xs">{children}</div>
    </div>
  );
}

const EM_DASH = "—";

function orDash(value: string | null): React.ReactNode {
  return value ?? <span className="text-muted-foreground">{EM_DASH}</span>;
}

/**
 * Rendered in place of the three attribution fields when the reader reaches
 * this fact only through publish-time grant widening (#4836).
 *
 * Says WHY, rather than rendering three em-dashes. An em-dash here would read
 * as "the evidence has no author and no timestamp", which is a statement about
 * the data and is false — and it is the kind of statement a reviewer acts on.
 *
 * The copy is deliberately about the AUDIENCE rather than about channel
 * membership. The dominant case is a private chat channel, but the withheld
 * arm is also reachable when the original grant was a `role:` the reader
 * lacks, or a `user:`, so "you are not in that channel" would be wrong some of
 * the time. "An audience you are not part of" is true of every ENTITLEMENT arm.
 * It is not true of the two drift arms (`attributionDecision` also withholds
 * when the column is missing from the SELECT or does not decode as an array) —
 * accepted, because those are unreachable-by-construction states that mean
 * Atlas has a defect, and inventing a fourth message for them would trade a
 * rare wrong sentence for a permanent confusing one.
 *
 * It promises WHO and WHEN, and deliberately not WHERE. The Grant panel below
 * renders `visibleTo` verbatim, which on a widened fact still names the
 * originating `audience:chat-channel:slack:<id>` — by design, and asserted by
 * test: a reviewer must be able to see the grant actually in force, and
 * `malformedGrantIndices` indexes into that list positionally. So the audience
 * is not secret on this surface; who spoke into it, and when, are. Do not
 * "fix" this by hiding the grant. (`searchBrain` carries no grant at all, so
 * the agent path discloses neither.)
 */
function AttributionRestricted() {
  return (
    <div className="col-span-2 flex items-start gap-2 rounded-md border border-dashed p-3">
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Attribution restricted.</span> This claim was
        first recorded under an audience you are not part of, and reaches you only because it was
        later restated under one you are. Who stated it first, and when, stay with that audience.
      </p>
    </div>
  );
}

function ProvenanceGrid({ provenance }: { provenance: BrainFactProvenanceView }) {
  const { attribution } = provenance;
  return (
    <div className="grid grid-cols-2 gap-4">
      <Field label="Source">{orDash(provenance.source)}</Field>
      <Field label="Producer">{orDash(provenance.producer)}</Field>
      {attribution.visible ? (
        <>
          <Field label="Asserted by">{orDash(attribution.actor)}</Field>
          <Field label="Source ID">
            <span className="font-mono break-all">{orDash(attribution.sourceId)}</span>
          </Field>
          <Field label="Said at">
            {attribution.occurredAt ? (
              <RelativeTimestamp iso={attribution.occurredAt} />
            ) : (
              orDash(null)
            )}
          </Field>
        </>
      ) : (
        <AttributionRestricted />
      )}
      <Field label="Extracted">
        {provenance.extractedAt ? <RelativeTimestamp iso={provenance.extractedAt} /> : orDash(null)}
      </Field>
    </div>
  );
}

/**
 * The read-time staleness signal (#4914), said in full.
 *
 * Four states, each honest about what it rests on:
 *   - a decoded observation → the level plus WHEN the claim was last observed;
 *   - an age anchored on the claim's other disclosed timestamps (`validFrom`
 *     — the claim's validity start, NOT an Atlas clock — else ingest) → the
 *     level plus the age, labelled as such; no observation is invented, and
 *     the copy must not claim ingest specifically, because this component
 *     cannot tell which of the two fallbacks won;
 *   - level with no numbers → the exact age is withheld WITH attribution
 *     (#4836): day-precision age restates the withheld "when", so a
 *     widened-in reader gets the bucket only, and this says why rather than
 *     rendering an em-dash that reads as "no age exists";
 *   - `unknown` → no timestamp decoded; claiming any age would fabricate one.
 *
 * Advisory throughout: nothing here demotes, expires, or re-ranks the claim.
 */
function DecaySignal({ decay }: { decay: BrainFactDecayView }) {
  const badge = decayBadge[decay.level];
  return (
    <div className="space-y-1">
      <Badge variant={badge.variant} className={badge.className}>
        <Clock className="mr-1 size-3" aria-hidden />
        {badge.label}
      </Badge>
      {decay.level === "unknown" ? (
        <p className="text-xs text-muted-foreground">
          No timestamp on this claim decoded, so its age cannot be stated.
        </p>
      ) : decay.lastObservedAt !== null ? (
        <p className="text-xs text-muted-foreground">
          <RelativeTimestamp iso={decay.lastObservedAt} label="Last observed" />
        </p>
      ) : decay.ageDays !== null ? (
        <p className="text-xs text-muted-foreground">
          About {decay.ageDays} {decay.ageDays === 1 ? "day" : "days"} old — no source
          observation recorded, so this is anchored on the claim&apos;s validity start or on when
          Atlas learned it.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Exact age withheld with attribution — it would restate when the claim was first said.
        </p>
      )}
    </div>
  );
}

/**
 * One counterpart of an advisory contradiction.
 *
 * Rendered with the SAME weight as the candidate above it and in the order the
 * API returned (deterministic, and deliberately not by recency, status, or
 * corroboration). There is no "keep this one" affordance: arbitration is M2's,
 * and refusing to auto-arbitrate is the point rather than a gap.
 */
function TensionCard({ tension }: { tension: BrainFactTensionView }) {
  if (tension.visible === false) {
    return (
      <div className="rounded-md border border-dashed p-3">
        <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldAlert className="size-3.5" aria-hidden />
          A conflicting claim exists that you are not allowed to see.
        </p>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground break-all">
          {tension.factId}
        </p>
      </div>
    );
  }

  const badge = statusBadge[tension.status];
  const withdrawn = tension.invalidatedAt !== null;
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className={`text-sm ${withdrawn ? "line-through decoration-muted-foreground" : ""}`}>
          <span className="font-medium">{tension.subject}</span>{" "}
          <span className="text-muted-foreground">{tension.predicate}</span>{" "}
          <span className="font-medium">{tension.object}</span>
        </p>
        <div className="flex shrink-0 gap-1">
          {/* Withdrawn is its own axis, not a status: retraction never writes
              `status`, so a retracted rival still reports whatever it held —
              "Draft" for a queue candidate, "Published" for one already
              promoted. Without this badge a resolved conflict is
              indistinguishable from a live one. */}
          {withdrawn && (
            <Badge variant="outline" className="border-muted-foreground/40 text-muted-foreground">
              Withdrawn
            </Badge>
          )}
          <Badge variant={badge.variant} className={badge.className}>
            {badge.label}
          </Badge>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {tension.corroborationCount} corroborating{" "}
        {tension.corroborationCount === 1 ? "source" : "sources"}
        {tension.ingestedAt && (
          <>
            {" · "}
            <RelativeTimestamp iso={tension.ingestedAt} label="Learned" />
          </>
        )}
      </p>
      <ProvenanceGrid provenance={tension.provenance} />
    </div>
  );
}

export function CandidateDetail({ candidate }: { candidate: BrainFactCandidate }) {
  const { provenance, episode, tensions, promotionBlock } = candidate;

  return (
    <div className="space-y-6 px-4">
      {/* The publish endpoint's own verdict, pre-flighted on read. `detail` is
          the API's actionable prose, rendered verbatim so the refusal
          vocabulary can grow without a copy change here. */}
      {promotionBlock && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertTitle>{blockedBadge.label}</AlertTitle>
          <AlertDescription>{promotionBlock.detail}</AlertDescription>
        </Alert>
      )}

      {provenance.provisional && (
        <Alert>
          <AlertTriangle className="size-4" aria-hidden />
          <AlertTitle>{provisionalBadge.label} entity resolution</AlertTitle>
          <AlertDescription>
            {provenance.unresolved.length > 0
              ? `Atlas could not pin the ${provenance.unresolved.join(" and ")} of this claim to a known entity, so it was recorded against a provisional one.`
              : "Atlas could not pin one side of this claim to a known entity, so it was recorded against a provisional one."}{" "}
            Publishing it is a decision that the entity is right, not just the claim.
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Claim</h3>
        <p className="rounded-md border bg-muted/50 p-3 text-sm">
          <span className="font-medium">{candidate.subject}</span>{" "}
          <span className="text-muted-foreground">{candidate.predicate}</span>{" "}
          <span className="font-medium">{candidate.object}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          {candidate.corroborationCount} corroborating{" "}
          {candidate.corroborationCount === 1 ? "source" : "sources"} ·{" "}
          {candidate.predicateCardinality === "single"
            ? "one value expected — a new value would supersede this"
            : "many values may coexist"}
        </p>
      </div>

      <div className="space-y-2 border-t pt-4">
        <h3 className="text-sm font-medium">Who can see it</h3>
        {!candidate.grantReadable && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" aria-hidden />
            <AlertTitle>Grant could not be read</AlertTitle>
            <AlertDescription>
              Atlas could not decode this claim&apos;s grant, so the list below is empty for a
              reason that has nothing to do with the claim. Do not read it as &ldquo;visible to
              nobody&rdquo; — this is an Atlas bug, and the claim may be visible workspace-wide.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-1">
          {candidate.visibleTo.length === 0 ? (
            <span className="text-xs text-muted-foreground">{EM_DASH}</span>
          ) : (
            candidate.visibleTo.map((token, i) => (
              <Badge
                // Grant tokens are not guaranteed unique at rest, so the index
                // is part of the identity here — and it is also what decides
                // the highlight, since a stored NULL renders as the
                // plausible-looking token `null` that a value match would miss.
                key={`${token}-${i}`}
                variant="outline"
                className={
                  candidate.malformedGrantIndices.includes(i)
                    ? "border-amber-300 font-mono text-amber-700 dark:border-amber-700 dark:text-amber-400"
                    : "font-mono"
                }
              >
                {token === "" ? "(empty)" : token}
              </Badge>
            ))
          )}
        </div>
        {candidate.malformedGrantIndices.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Highlighted tokens are outside the grant grammar and grant nobody access. Valid tokens
            are <code>org</code>, <code>role:owner</code>, <code>role:admin</code>,{" "}
            <code>role:member</code>, <code>user:&lt;id&gt;</code>, or{" "}
            <code>audience:&lt;name&gt;</code>.
          </p>
        )}
      </div>

      <div className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-medium">Provenance</h3>
        {!provenance.payloadComplete && (
          <p className="text-xs text-muted-foreground">
            Some provenance fields are missing from the stored payload — what is shown below is
            everything Atlas recorded, not everything it was supposed to.
          </p>
        )}
        <ProvenanceGrid provenance={provenance} />

        {/* The episode passes its OWN visibility check, not the fact's: a claim
            can be org-visible while the message it came from stays private. */}
        {episode === null ? (
          <p className="text-xs text-muted-foreground">No source episode recorded.</p>
        ) : episode.visible === true ? (
          <div className="space-y-2">
            <span className="text-xs font-medium text-muted-foreground">Source episode</span>
            {episode.body !== null && (
              <pre className="max-h-64 overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-3 font-mono text-xs">
                {episode.body}
                {episode.bodyTruncated && "\n… (truncated)"}
              </pre>
            )}
            {episode.locator !== null && (
              <p className="font-mono text-xs break-all">{episode.locator}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {episode.source ?? "unknown source"}
              {episode.sourceActor && ` · ${episode.sourceActor}`}
              {episode.occurredAt && (
                <>
                  {" · "}
                  <RelativeTimestamp iso={episode.occurredAt} />
                </>
              )}
            </p>
          </div>
        ) : (
          <Alert>
            <ShieldAlert className="size-4" aria-hidden />
            <AlertTitle>Evidence restricted</AlertTitle>
            <AlertDescription>
              This claim came from an episode you are not allowed to read — the fact and its
              evidence carry separate grants. You can see what was concluded, but not what was
              said. Approving it means trusting the extraction without reading the source.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {tensions.length > 0 && (
        <div className="space-y-3 border-t pt-4">
          <h3 className="inline-flex items-center gap-1.5 text-sm font-medium">
            <Split className="size-4 text-muted-foreground" aria-hidden />
            Conflicting claims
          </h3>
          <p className="text-xs text-muted-foreground">
            Atlas noticed these claims disagree and is not choosing between them. Both are shown
            with their own evidence; deciding which holds is your call.
          </p>
          {tensions.map((tension) => (
            <TensionCard key={`${tension.edgeDirection}-${tension.factId}`} tension={tension} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 border-t pt-4">
        <Field label="Staleness">
          <DecaySignal decay={candidate.decay} />
        </Field>
        <Field label="Valid from">
          {candidate.validFrom ? <RelativeTimestamp iso={candidate.validFrom} /> : orDash(null)}
        </Field>
        <Field label="Valid to">
          {candidate.validTo ? <RelativeTimestamp iso={candidate.validTo} /> : orDash(null)}
        </Field>
        <Field label="Learned">
          {candidate.ingestedAt ? (
            <RelativeTimestamp iso={candidate.ingestedAt} />
          ) : (
            orDash(null)
          )}
        </Field>
        <Field label="Fact ID">
          <span className="font-mono break-all">{candidate.id}</span>
        </Field>
      </div>
    </div>
  );
}
