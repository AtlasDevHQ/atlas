"use client";

import { answerTrustTierPresentation } from "@useatlas/schemas";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The chip that states an answer's trust tier (#5451, ADR-0036).
 *
 * The vocabulary and the meanings live in one table
 * (`@useatlas/schemas/trust-tier`); this is only how it draws. Colour is the
 * secondary channel — the label is always present as text, because a tier
 * distinguished only by hue is not carried for anyone who cannot see hue.
 *
 * ## Unrecognized tiers render LOUDLY
 *
 * `answerTrustTierPresentation` returns `null` for a value this build does not
 * know, and the fallback below draws a visible warning chip carrying the raw
 * value rather than returning `null`. That asymmetry is the whole point of the
 * component: #5451 is a bug about a tier that reached a person unlabelled, and
 * a badge that silently renders nothing for an unknown tier would reproduce it
 * one wire-format change later. There is no code path here that renders
 * nothing.
 */
export function TierBadge({
  tier,
  className,
}: {
  /** The wire tier value. Deliberately `string` — this is untrusted input from a tool result. */
  tier: string;
  className?: string;
}) {
  const presentation = answerTrustTierPresentation(tier);

  if (!presentation) {
    return (
      <Badge
        variant="destructive"
        data-testid="tier-badge"
        data-tier={tier}
        data-tier-known="false"
        title={`Atlas does not recognize the trust tier "${tier}". Treat this result's authority as unknown.`}
        className={cn(CHIP_SHAPE, className)}
      >
        {/* ⚠️ Never a bare "unknown tier:" with nothing after it. A tier that is
            absent or blank on the wire is exactly the shape #5451 is about, and
            a trailing colon pointing at nothing reads as a rendering bug rather
            than as the warning it is. */}
        {tier ? `unknown tier: ${tier}` : "tier missing"}
      </Badge>
    );
  }

  return (
    <Badge
      variant="secondary"
      data-testid="tier-badge"
      data-tier={presentation.tier}
      data-tier-known="true"
      title={presentation.meaning}
      aria-label={`${presentation.label} — ${presentation.meaning}`}
      className={cn(CHIP_SHAPE, TIER_CHIP_CLASS[presentation.tier], className)}
    >
      {presentation.label}
    </Badge>
  );
}

/**
 * The chip's own metrics, layered over the shadcn `Badge`.
 *
 * `Badge` owns the shape, focus ring and layout; this narrows it to the
 * receipt row's density. Only what actually differs is restated — restating
 * `inline-flex`/`shrink-0` here is how a component stops tracking the
 * primitive it is built on.
 */
const CHIP_SHAPE = "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide";

/**
 * Chip colours, keyed by tier so a new tier fails to compile here too.
 *
 * Kept out of the shared table on purpose: Tailwind class strings are this
 * surface's business, and the widget's palette is its own. What must not drift
 * is the vocabulary, and that is what the shared table holds.
 */
export const TIER_CHIP_CLASS: Record<
  NonNullable<ReturnType<typeof answerTrustTierPresentation>>["tier"],
  string
> = {
  warehouse: "bg-emerald-100 text-emerald-700 dark:bg-emerald-600/20 dark:text-emerald-400",
  attested: "bg-blue-100 text-blue-700 dark:bg-blue-600/20 dark:text-blue-400",
  "on-record": "bg-amber-100 text-amber-800 dark:bg-amber-600/20 dark:text-amber-400",
  document: "bg-violet-100 text-violet-700 dark:bg-violet-600/20 dark:text-violet-400",
};
