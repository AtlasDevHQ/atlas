import type { ComponentProps, FC, ReactNode } from "react";
import type { Audience } from "@/lib/audience";

/**
 * Build-time audience conditionals — the segmentation's CORE security primitive
 * (PRD #4257, slice #4260).
 *
 * These are SERVER components, resolved PER MOUNT from the route's static
 * `audience` prop (NOT React context). That distinction is load-bearing: a
 * CLIENT conditional (`useAudience() === … ? children : null`) still serializes
 * its `children` into the RSC flight payload that Next inlines into the static
 * HTML — so the "hidden" branch is present in the emitted HTML, only visually
 * absent. A SERVER component that returns `null` never renders its children, so
 * the branch is absent from the emitted HTML entirely (verified against the
 * static export). A SaaS reader is structurally unable to receive the
 * self-hosted branch, and vice versa.
 *
 * `SectionDocsPage` builds these once for its mount and passes them into the MDX
 * `components` map, so authoring stays declarative:
 *   <WhenSaaS>…</WhenSaaS> / <WhenSelfHosted>…</WhenSelfHosted>.
 */

interface ConditionalProps {
  children?: ReactNode;
}

/** Active branch: render children unchanged. */
function ShowChildren({ children }: ConditionalProps): ReactNode {
  return <>{children}</>;
}

/**
 * Inactive branch: render nothing. Because this is a server component that never
 * touches `children`, those child elements are never rendered and never enter
 * the RSC flight payload — the branch is absent from the emitted HTML.
 */
function RenderNothing(_props: ConditionalProps): ReactNode {
  return null;
}

export interface AudienceConditionals {
  readonly WhenSaaS: (props: ConditionalProps) => ReactNode;
  readonly WhenSelfHosted: (props: ConditionalProps) => ReactNode;
}

/**
 * Resolve the two audience conditionals for a given mount. On the SaaS mount
 * `WhenSelfHosted` is `RenderNothing`; on the self-hosted mount `WhenSaaS` is.
 */
export function audienceConditionals(audience: Audience): AudienceConditionals {
  return {
    WhenSaaS: audience === "saas" ? ShowChildren : RenderNothing,
    WhenSelfHosted: audience === "self-hosted" ? ShowChildren : RenderNothing,
  };
}

/**
 * Props for `<AudienceLink>` — a per-mount link with an OPTIONAL href for each
 * audience. The link resolves to at most ONE audience's href; the omitted
 * audience renders the same text as PLAIN prose (no `<a>`), so the link can
 * never cross the SaaS/self-hosted boundary (PRD #4257, slice #4289).
 */
export interface AudienceLinkProps {
  /** href used only on the SaaS mount; omit to render plain text there. */
  readonly saas?: string;
  /** href used only on the self-hosted mount; omit to render plain text there. */
  readonly selfHosted?: string;
  readonly children?: ReactNode;
}

/**
 * Build the mount-scoped `<AudienceLink>` for the shared-page cross-link problem
 * (#4289). A shared page (`content/shared/**`) mounts into BOTH the SaaS root and
 * `/self-hosted`, so a single hard-coded root-absolute link leaks: a
 * `[Admin Console](/guides/admin-console)` (a SaaS-only page) sends a self-hosted
 * reader to SaaS content, and a `[Auth](/self-hosted/...)` sends a SaaS reader
 * into the self-hosted section. `<AudienceLink>` picks the href for THIS mount and
 * renders plain text when the current audience has no appropriate target — so
 * the emitted HTML on each mount only ever links within that audience's surface.
 *
 * The active branch renders through the injected `LinkComponent` (the mount's
 * `createRelativeLink` result — the same component mapped to `a`) so client-side
 * navigation and fumadocs' link handling stay consistent with an ordinary MDX
 * link; the inactive branch is a bare fragment (no anchor), the string-surface
 * twin of `resolveAudienceLinks(…)` dropping the link in the `.mdx` /
 * `llms-full.txt` output.
 */
export function makeAudienceLink(
  audience: Audience,
  LinkComponent: FC<ComponentProps<"a">>,
): (props: AudienceLinkProps) => ReactNode {
  return function AudienceLink({ saas, selfHosted, children }: AudienceLinkProps) {
    // Explicit positive match per audience (fail closed): an unexpected audience
    // yields NO href — plain text — mirroring the both-branches-stripped
    // behaviour of `stripInactiveAudienceBlocks`, rather than silently defaulting
    // to one branch's target on a cross-boundary primitive.
    const href =
      audience === "saas"
        ? saas
        : audience === "self-hosted"
          ? selfHosted
          : undefined;
    if (href == null || href === "") return <>{children}</>;
    return <LinkComponent href={href}>{children}</LinkComponent>;
  };
}
