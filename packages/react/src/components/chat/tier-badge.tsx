"use client";

import { answerTrustTierPresentation, type AnswerTrustTier } from "../../lib/trust-tier";
import { cn } from "../../lib/utils";

/**
 * The chip that states an answer's trust tier (#5451, ADR-0036).
 *
 * The embeddable widget is a UI surface under the invariant's wording, so it
 * carries the label on the same terms the first-party chat does. Vocabulary and
 * meanings come from `lib/trust-tier.ts` (a pinned mirror of the canonical
 * table — see its header); this is only how it draws.
 *
 * There is no code path here that renders nothing: an unrecognized tier draws a
 * loud warning chip carrying the raw value, because a badge that silently
 * disappears for an unknown tier reproduces the bug this component exists for.
 */
export function TierBadge({
  tier,
  className,
}: {
  /** The wire tier value. Deliberately `string` — untrusted input from a tool result. */
  tier: string;
  className?: string;
}) {
  const presentation = answerTrustTierPresentation(tier);

  if (!presentation) {
    return (
      <span
        data-testid="tier-badge"
        data-tier={tier}
        data-tier-known="false"
        title={`Atlas does not recognize the trust tier "${tier}". Treat this result's authority as unknown.`}
        className={cn(
          "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
          "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400",
          className,
        )}
      >
        {/* ⚠️ Never a bare "unknown tier:" with nothing after it. A tier absent
            or blank on the wire is exactly the shape #5451 is about, and a
            trailing colon pointing at nothing reads as a rendering bug rather
            than as the warning it is. */}
        {tier ? `unknown tier: ${tier}` : "tier missing"}
      </span>
    );
  }

  return (
    <span
      data-testid="tier-badge"
      data-tier={presentation.tier}
      data-tier-known="true"
      title={presentation.meaning}
      aria-label={`${presentation.label} — ${presentation.meaning}`}
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        TIER_CHIP_CLASS[presentation.tier],
        className,
      )}
    >
      {presentation.label}
    </span>
  );
}

/** Chip colours, keyed by tier so a new tier fails to compile here too. */
export const TIER_CHIP_CLASS: Record<AnswerTrustTier, string> = {
  warehouse: "bg-emerald-100 text-emerald-700 dark:bg-emerald-600/20 dark:text-emerald-400",
  fact: "bg-blue-100 text-blue-700 dark:bg-blue-600/20 dark:text-blue-400",
  "raw-episode": "bg-amber-100 text-amber-800 dark:bg-amber-600/20 dark:text-amber-400",
  document: "bg-violet-100 text-violet-700 dark:bg-violet-600/20 dark:text-violet-400",
};
