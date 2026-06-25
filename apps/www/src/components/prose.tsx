import { type ReactNode } from "react";

import { ArrowIcon, AtlasLogo } from "./shared";

/* ---------------------------------------------------------------------------
 * Blog prose system — shared long-form primitives for /blog posts.
 *
 * One reading column, one type ramp, one set of editorial beats (lead, pull
 * quote, stat strip, definition list, numbered steps). Both posts import from
 * here so the typography stays identical and tuned in one place. Drives all
 * color through brand tokens (text-fg / text-accent / --code-*); no hardcoded
 * values. See PRODUCT.md › Aesthetic Direction + the landing's BigStat / EndCta
 * for the shared display-number and mono-caption language this echoes.
 * ------------------------------------------------------------------------- */

// ── Shell ──────────────────────────────────────────────────────────────────

/** The reading column. ~70ch at the body size — within the 65–75ch target. */
export function Article({ children }: { children: ReactNode }) {
  return (
    <article className="mx-auto max-w-[680px] px-6 pt-24 pb-20 md:pt-32 md:pb-28">
      {children}
    </article>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

export interface PostHeaderProps {
  tag: string;
  /** ISO date for the <time> machine attribute. */
  isoDate: string;
  /** Human label, e.g. "June 25, 2026". */
  dateLabel: string;
  readingTime: string;
  title: ReactNode;
  dek: ReactNode;
}

export function PostHeader({
  tag,
  isoDate,
  dateLabel,
  readingTime,
  title,
  dek,
}: PostHeaderProps) {
  return (
    <header className="mb-14">
      <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px]">
        <span className="rounded-full border border-accent/25 bg-accent-quiet px-2.5 py-0.5 font-medium tracking-[0.12em] text-accent uppercase">
          {tag}
        </span>
        <time dateTime={isoDate} className="tracking-[0.04em] text-fg-faint">
          {dateLabel}
        </time>
        <span aria-hidden className="text-border-strong">·</span>
        <span className="tracking-[0.04em] text-fg-faint">{readingTime}</span>
      </div>
      <h1 className="animate-fade-in-up delay-100 text-[clamp(2rem,1.4rem+2.6vw,3.25rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-balance text-fg">
        {title}
      </h1>
      <p className="animate-fade-in-up delay-200 mt-6 text-[clamp(1.125rem,1.04rem+0.5vw,1.375rem)] leading-[1.5] tracking-[-0.01em] text-pretty text-fg-muted">
        {dek}
      </p>
      <Byline />
    </header>
  );
}

/** Author block — the Atlas mark in a forest chip + name and role. */
export function Byline() {
  return (
    <div className="animate-fade-in-up delay-300 mt-8 flex items-center gap-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-quiet ring-1 ring-accent/20">
        <AtlasLogo className="h-4 w-4 text-accent" />
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-medium text-fg">Matt Sywulak</span>
        <span className="block font-mono text-[11px] tracking-[0.04em] text-fg-faint">
          Founder, Atlas
        </span>
      </span>
    </div>
  );
}

// ── Body ─────────────────────────────────────────────────────────────────────

/** Opening paragraph — a touch larger and in full ink to drop the reader in. */
export function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="mb-6 text-[19px] leading-[1.6] tracking-[-0.01em] text-pretty text-fg">
      {children}
    </p>
  );
}

export function P({ children }: { children: ReactNode }) {
  return (
    <p className="mb-6 text-[17px] leading-[1.72] tracking-[-0.005em] text-pretty text-fg-muted">
      {children}
    </p>
  );
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="mt-16 mb-5 scroll-mt-24 text-[1.5rem] font-semibold leading-[1.15] tracking-[-0.02em] text-balance text-fg md:text-[1.75rem]">
      {children}
    </h2>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-bg-sunken px-1.5 py-0.5 font-mono text-[0.85em] text-fg">
      {children}
    </code>
  );
}

/** Dark "terminal window" floating on the cream — the page's technical hero
 *  asset. Graduated chrome dots read as a real window without skeuomorphism. */
export function CodeBlock({
  title,
  children,
}: {
  title: string;
  children: string;
}) {
  return (
    <div className="my-8 overflow-hidden rounded-xl border border-code-border bg-code-bg shadow-pane">
      <div className="flex items-center gap-2 border-b border-code-border px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-code-muted/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-code-muted/45" />
        <span className="h-2.5 w-2.5 rounded-full bg-code-muted/30" />
        <span className="ml-3 font-mono text-xs text-code-muted">{title}</span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-sm leading-relaxed text-code-fg">
        <code>{children}</code>
      </pre>
    </div>
  );
}

/** A forest-accent display quote that breaks the text column for rhythm. */
export function PullQuote({ children }: { children: ReactNode }) {
  return (
    <figure className="my-12">
      <blockquote className="text-[clamp(1.375rem,1.1rem+1.2vw,1.875rem)] font-semibold leading-[1.22] tracking-[-0.02em] text-balance text-accent">
        {children}
      </blockquote>
    </figure>
  );
}

// ── Editorial beats ──────────────────────────────────────────────────────────

export interface Stat {
  value: string;
  label: string;
}

/** Stat strip echoing the landing's BigStat language: big forest numerals,
 *  mono caption. A visual anchor between prose, not a hero metric. */
export function StatStrip({ items }: { items: Stat[] }) {
  return (
    <dl className="my-12 grid grid-cols-1 gap-x-8 gap-y-7 border-y border-border-soft py-8 sm:grid-cols-3">
      {items.map((it) => (
        <div key={it.label}>
          <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-faint">
            {it.label}
          </dt>
          <dd className="mt-2 text-[2.75rem] font-semibold leading-[0.95] tracking-[-0.04em] text-accent md:text-[3.25rem]">
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Two-column definition list: term rail + description. Replaces inline
 *  bold-title bullets with a scannable, aligned structure. */
export function DefList({ children }: { children: ReactNode }) {
  return <dl className="my-8 space-y-6">{children}</dl>;
}

export function DefItem({
  term,
  children,
}: {
  term: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[170px_1fr] sm:gap-7">
      <dt className="text-[15px] font-semibold leading-snug text-fg">{term}</dt>
      <dd className="text-[15px] leading-[1.6] text-fg-muted">{children}</dd>
    </div>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="my-8 space-y-3.5">{children}</ol>;
}

export function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1.875rem_1fr] items-baseline gap-3 text-[15px]">
      <span className="font-mono text-[13px] font-medium tabular-nums text-accent">
        {String(n).padStart(2, "0")}
      </span>
      <span className="leading-[1.55] text-fg-muted">
        <span className="font-medium text-fg">{title}</span>: {children}
      </span>
    </li>
  );
}

// ── Footer pieces ────────────────────────────────────────────────────────────

/** Primary demo + GitHub actions, shared by both posts. */
export function PostActions() {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-3">
      <a
        href="https://app.useatlas.dev/demo"
        className="group inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-hover"
      >
        Try the live demo
        <ArrowIcon />
      </a>
      <a
        href="https://github.com/AtlasDevHQ/atlas"
        className="group inline-flex items-center gap-2 rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
      >
        Star on GitHub
        <ArrowIcon />
      </a>
    </div>
  );
}

export function Signoff() {
  return (
    <p className="mt-10 text-[17px] leading-relaxed text-fg">
      <span aria-hidden>— </span>Matt
    </p>
  );
}

export function BackToBlog() {
  return (
    <div className="mt-16 border-t border-border pt-8">
      <a
        href="/blog"
        className="group inline-flex items-center gap-1.5 font-mono text-xs text-fg-faint transition-colors hover:text-fg-muted"
      >
        <ArrowIcon className="h-3 w-3 rotate-180 transition-transform group-hover:-translate-x-0.5" />
        Back to blog
      </a>
    </div>
  );
}
