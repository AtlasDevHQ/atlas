import type { ReactNode } from "react";
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
