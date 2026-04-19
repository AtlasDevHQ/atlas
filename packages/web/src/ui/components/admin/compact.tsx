"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────
 *  Admin "compact" primitives
 *
 *  Progressive-disclosure vocabulary shared across revamped admin pages
 *  (integrations, billing, sandbox, branding, custom-domain, residency,
 *  model-config, settings, starter-prompts, plugins, sso, connections,
 *  scim, ip-allowlist). Extracted from 14 inline duplications per #1551.
 *
 *  Design intent:
 *   - StatusKind is the widest union across callers; kinds not used by a
 *     given page are simply never passed. Prefer this over per-page forks.
 *   - Shell is intentionally generic (not "IntegrationShell" /
 *     "ConnectionShell" / etc.) so callers can import one primitive
 *     regardless of which surface they're building.
 *   - `statusLabel` on Shell overrides the default connected/unhealthy pill
 *     text. CompactRow's sr-only status label uses STATUS_LABEL defaults;
 *     pages with different semantics (e.g. plugins = "Enabled"/"Disabled")
 *     can pass their own `statusLabel` override.
 * ──────────────────────────────────────────────────────────────────────── */

export type StatusKind =
  | "connected"
  | "disconnected"
  | "unavailable"
  | "ready"
  | "transitioning"
  | "unhealthy";

/** Default human-readable status labels. Consumers can override per-call via
 *  `statusLabel` on Shell / CompactRow when page semantics differ. */
export const STATUS_LABEL: Record<StatusKind, string> = {
  connected: "Connected",
  disconnected: "Not connected",
  unavailable: "Unavailable",
  ready: "Ready",
  transitioning: "Transitioning",
  unhealthy: "Unhealthy",
};

/* ────────────────────────────────────────────────────────────────────────
 *  StatusDot — a 1.5×1.5 dot with color and halo per status kind.
 * ──────────────────────────────────────────────────────────────────────── */

export function StatusDot({
  kind,
  className,
}: {
  kind: StatusKind;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-1.5 shrink-0 rounded-full",
        kind === "connected" &&
          "bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_15%,transparent)]",
        kind === "ready" && "bg-primary/70",
        // `--warning` isn't part of the shadcn neutral base — hardcoded
        // amber-500 with an oklch halo mirrors the teal convention.
        kind === "transitioning" &&
          "bg-amber-500 shadow-[0_0_0_3px_color-mix(in_oklch,oklch(0.75_0.17_70)_15%,transparent)]",
        kind === "unhealthy" &&
          "bg-destructive shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive)_15%,transparent)]",
        kind === "disconnected" && "bg-muted-foreground/40",
        kind === "unavailable" &&
          "bg-muted-foreground/20 outline-1 outline-dashed outline-muted-foreground/30",
        className,
      )}
    >
      {kind === "connected" && (
        <span className="absolute inset-0 rounded-full bg-primary/60 motion-safe:animate-ping" />
      )}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 *  CompactRow — thin single-line row with icon, title, status dot, and
 *  optional trailing action. Used for collapsed disconnected/unavailable
 *  entries in a progressive-disclosure layout.
 * ──────────────────────────────────────────────────────────────────────── */

export function CompactRow({
  icon: Icon,
  title,
  description,
  status,
  statusLabel,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: ReactNode;
  status: StatusKind;
  /** Override the default sr-only status text. */
  statusLabel?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 rounded-xl border bg-card/40 px-3.5 py-2.5 transition-colors",
        "hover:bg-card/70 hover:border-border/80",
        status === "transitioning" && "border-amber-500/20",
        status === "unhealthy" && "border-destructive/20",
        status === "unavailable" && "opacity-60",
      )}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border bg-background/40 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
            {title}
          </h3>
          <StatusDot kind={status} className="shrink-0" />
          <span className="sr-only">
            Status: {statusLabel ?? STATUS_LABEL[status]}
          </span>
        </div>
        {description != null && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 *  Shell — full expanded card with icon, title, status pill, body,
 *  and footer actions. Used for connected and user-expanded items.
 * ──────────────────────────────────────────────────────────────────────── */

export function Shell({
  id,
  icon: Icon,
  title,
  titleText,
  titleBadge,
  description,
  status,
  statusLabel,
  trailing,
  onCollapse,
  children,
  actions,
  panelRef,
}: {
  id?: string;
  icon: ComponentType<{ className?: string }>;
  title: ReactNode;
  /** Plain-text title for aria-label when `title` is JSX. Required if
   *  `title` is not a string and you want screen readers to announce the
   *  real item identity instead of the generic word "item". */
  titleText?: string;
  titleBadge?: ReactNode;
  description: ReactNode;
  status: StatusKind;
  /** Override the default "Live" / "Unhealthy" pill text. */
  statusLabel?: string;
  /** Override the trailing header ornament (default is the Live/Unhealthy
   *  pill when status warrants one, otherwise nothing). Callers that pass
   *  their own trailing (e.g. a Switch + caption) get the X collapse button
   *  rendered alongside so the user is never stuck with no way out. */
  trailing?: ReactNode;
  onCollapse?: () => void;
  children?: ReactNode;
  actions?: ReactNode;
  panelRef?: RefObject<HTMLElement | null>;
}) {
  const ariaTitle =
    titleText ?? (typeof title === "string" ? title : "Item");

  const defaultTrailing =
    status === "connected" ? (
      <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-primary">
        <StatusDot kind="connected" />
        {statusLabel ?? "Live"}
      </span>
    ) : status === "unhealthy" ? (
      <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-destructive">
        <StatusDot kind="unhealthy" />
        {statusLabel ?? "Unhealthy"}
      </span>
    ) : null;

  // Collapse X always renders when `onCollapse` is provided — even when
  // caller passes its own `trailing` — so consumers that supply a Switch
  // or custom ornament still give users a way out. (Regression guard:
  // plugins initially dropped the X when `trailing` was set; see #1560.)
  const hasCollapse = status !== "connected" && onCollapse !== undefined;

  return (
    <section
      id={id}
      ref={panelRef}
      aria-label={
        status === "connected" || status === "unhealthy"
          ? `${ariaTitle}: ${statusLabel ?? STATUS_LABEL[status]}`
          : undefined
      }
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border bg-card/60 backdrop-blur-[1px] transition-colors",
        "hover:border-border/80",
        status === "connected" && "border-primary/20",
        status === "transitioning" && "border-amber-500/30",
        status === "unhealthy" && "border-destructive/30",
        status === "unavailable" && "border-destructive/20",
      )}
    >
      {status === "connected" && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-4 bottom-4 w-px bg-linear-to-b from-transparent via-primary to-transparent opacity-70"
        />
      )}
      {status === "unhealthy" && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-4 bottom-4 w-px bg-linear-to-b from-transparent via-destructive to-transparent opacity-70"
        />
      )}

      <header className="flex items-start gap-3 p-4 pb-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border bg-background/40",
            status === "connected" && "border-primary/30 text-primary",
            status === "ready" && "text-primary/80",
            status === "transitioning" &&
              "border-amber-500/30 text-amber-600 dark:text-amber-400",
            status === "unhealthy" && "border-destructive/30 text-destructive",
            (status === "disconnected" || status === "unavailable") &&
              "text-muted-foreground",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold leading-tight tracking-tight">
              {title}
            </h3>
            {titleBadge}
            <div className="ml-auto flex items-center gap-1.5">
              {trailing !== undefined ? trailing : defaultTrailing}
              {hasCollapse && (
                <button
                  type="button"
                  aria-label="Collapse"
                  onClick={onCollapse}
                  className="-m-1 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>
          {description != null && (
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </header>

      {children != null && (
        <div className="flex-1 space-y-3 px-4 pb-3 text-sm">{children}</div>
      )}

      {actions && (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50 bg-muted/20 px-4 py-2.5">
          {actions}
        </footer>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 *  DetailList / DetailRow — bordered key/value spec sheet for the Shell body.
 * ──────────────────────────────────────────────────────────────────────── */

export function DetailList({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-1.5 divide-y divide-border/50">
      {children}
    </div>
  );
}

export function DetailRow({
  label,
  value,
  mono,
  truncate,
}: {
  label: string;
  value: ReactNode;
  /** Render value with tabular-mono font (for IDs, hashes, tokens). */
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 text-right",
          mono && "font-mono text-[11px]",
          truncate && "truncate",
          !mono && "font-medium",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 *  InlineError — destructive-tinted block for per-item error surfaces
 *  inside a Shell body.
 * ──────────────────────────────────────────────────────────────────────── */

export function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {children}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 *  SectionHeading — eyebrow + subtext shown above a section's rows.
 * ──────────────────────────────────────────────────────────────────────── */

export function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {title}
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground/80">{description}</p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 *  useDisclosure — encapsulates the concerns every progressive-disclosure
 *  card needs:
 *   1. expand/collapse state + stable panel id
 *   2. focus into first form field on expand
 *   3. return focus to trigger on collapse
 *   4. caller-provided cleanup hook on collapse (mutation reset, etc.)
 *   5. optional auto-collapse when an external signal flips to true
 *      (e.g. integration becomes connected after successful BYOT flow)
 * ──────────────────────────────────────────────────────────────────────── */

export function useDisclosure(
  options: {
    /** Called after the panel closes (manual X, programmatic `collapse()`,
     *  or auto-collapse). Use to reset a mutation error so dismissing the
     *  panel can never silently hide an unread failure. */
    onCollapseCleanup?: () => void;
    /** When this flips from false to true, the panel auto-collapses.
     *  Typical use: pass the resource's "connected" flag so a successful
     *  connect flow closes the form under the user. */
    collapseOn?: boolean;
  } = {},
) {
  const { onCollapseCleanup, collapseOn } = options;
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelId = useId();
  const prevExpanded = useRef(false);

  // Auto-reset expanded state when the caller-provided signal goes true —
  // e.g. an integration that just flipped to `connected`. Keeps a later
  // disconnect from re-opening the form under a stale `expanded=true`.
  useEffect(() => {
    if (collapseOn) setExpanded(false);
  }, [collapseOn]);

  // Focus management on transitions:
  //   expanded ↑ — focus the first form field in the revealed panel
  //   expanded ↓ — return focus to the trigger button
  useEffect(() => {
    if (expanded && !prevExpanded.current) {
      const panel = panelRef.current;
      const first = panel?.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), button[role="combobox"]:not([disabled])',
      );
      first?.focus();
    } else if (!expanded && prevExpanded.current) {
      triggerRef.current?.focus();
    }
    prevExpanded.current = expanded;
  }, [expanded]);

  const collapse = () => {
    setExpanded(false);
    onCollapseCleanup?.();
  };

  return { expanded, setExpanded, collapse, triggerRef, panelRef, panelId };
}
