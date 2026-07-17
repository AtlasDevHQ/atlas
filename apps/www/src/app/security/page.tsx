import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { LegalSection, LegalTOC, type LegalSectionData } from "../../components/legal";
import { Nav } from "../../components/nav";
import { TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";

export const metadata: Metadata = {
  title: "Security",
  description:
    "Defense in depth for pointing an AI agent at your database: seven-layer SQL validation, read-only connections, sandboxed tools, and AES-256-GCM encrypted credentials. All open source.",
  openGraph: {
    title: "Security — Atlas",
    description:
      "How Atlas makes connecting your production database to an AI agent a defensible decision: read-only by construction, seven-layer SQL validation, network-denied sandbox, encrypted-at-rest credentials. Verify it all in open source.",
    url: "https://www.useatlas.dev/security",
    siteName: "Atlas",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Security — Atlas",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Security — Atlas",
    description:
      "How Atlas makes connecting your production database to an AI agent a defensible decision: read-only by construction, seven-layer SQL validation, network-denied sandbox, encrypted-at-rest credentials. Verify it all in open source.",
    images: ["/og.png"],
  },
  alternates: { canonical: "https://www.useatlas.dev/security" },
};

interface Pillar {
  mono: string;
  label: string;
  sub: string;
}

const PILLARS: Pillar[] = [
  {
    mono: "select_only",
    label: "Read-only by construction",
    sub: "The agent can only SELECT. INSERT, UPDATE, DELETE, DROP — every write is blocked before it reaches your database, and the connection itself is opened read-only.",
  },
  {
    mono: "seven_validators",
    label: "Seven-layer SQL validation",
    sub: "Every query is parsed to an AST, checked against a table allowlist from your semantic layer, row-limited, and timed out. Anything unparseable is rejected, never guessed at.",
  },
  {
    mono: "sandboxed",
    label: "Sandboxed tool execution",
    sub: "The agent's explore and Python tools run in an isolated sandbox — a network-denied microVM on Atlas Cloud — with read-only access scoped to your semantic layer, never your filesystem or secrets.",
  },
  {
    mono: "encrypted",
    label: "Credentials encrypted at rest",
    sub: "Connection strings and API keys are AES-256-GCM encrypted at rest, masked in every API response, and isolated per tenant — never logged, never returned in plaintext.",
  },
];

const SECTIONS: LegalSectionData[] = [
  {
    id: "threat-model",
    title: "What we're defending against",
    legal: [
      "Atlas points an AI agent at your database. Done naively, that's a liability: a model that can write arbitrary SQL could drop a table, read a column it was never meant to see, or pin your database with a runaway scan. The controls on this page exist so that connecting Atlas to a production database is a defensible decision, not a leap of faith.",
      "The design principle is defense in depth — no single control is load-bearing. SQL validation, read-only connections, sandbox isolation, and credential encryption are independent layers, so a bug in any one is backstopped by the others. Every layer fails closed: when a check can't run or a query can't be parsed, the query is rejected, not waved through.",
      "All of it ships in the open-source codebase under AGPL-3.0. You don't have to trust a marketing page — you can read the validator, run it in your own infrastructure, and watch every query the agent runs.",
    ],
    plain:
      "Pointing an AI at your database is risky by default. Atlas layers independent controls — validation, read-only access, sandboxing, encryption — so no single failure is catastrophic. It's all open source, so you can verify it.",
  },
  {
    id: "sql-validation",
    title: "Seven-layer SQL validation",
    legal: [
      "Every query the agent writes runs through a seven-stage pipeline before it touches your data. A fast regex pass first rejects DML and DDL keywords — INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, and more — with SQL comments stripped beforehand so they can't be used to smuggle a keyword past the check.",
      "The query is then parsed to an abstract syntax tree with node-sql-parser (PostgreSQL or MySQL mode, auto-detected). Only a single SELECT statement survives: batched statements separated by semicolons are rejected, and a query that fails to parse is rejected outright — never executed on a best-effort guess.",
      "Every table the query references is checked against an allowlist derived from your semantic-layer entity definitions. A table that isn't described in your semantic layer can't be queried; CTE names are recognized as query-local and excluded from the check; schema-qualified names must match a qualified allowlist entry.",
      "Three more controls apply at execution time: optional row-level-security filters are injected for tenant isolation, a row limit (1,000 by default, configurable via ATLAS_ROW_LIMIT) is appended to any query that doesn't already specify one, and a statement timeout (30 seconds by default, via ATLAS_QUERY_TIMEOUT) kills queries that run too long.",
    ],
    plain:
      "Every query is parsed, allowlisted against your semantic layer, row-limited, and timed out. Anything that isn't a single readable SELECT is blocked before it runs.",
  },
  {
    id: "read-only",
    title: "Read-only database connections",
    legal: [
      "Validation is the first line of defense, not the only one. The database session itself is opened read-only, so even a query that somehow slipped past validation can't modify your data.",
      "On PostgreSQL, Atlas sets default_transaction_read_only = on. On MySQL, it issues SET SESSION TRANSACTION READ ONLY. On ClickHouse, the connection runs with readonly: 1. The enforcement lives inside the database engine, below Atlas's own code — the strongest place to put it.",
      "Atlas connects to your warehouse with whatever credentials you provide. We recommend — and document — pointing it at a read replica or a least-privilege role that only has SELECT on the tables you expose. Read-only at the session level is a backstop, not a substitute for a scoped database role.",
    ],
    plain:
      "Beyond validation, the connection is read-only at the database session level on Postgres, MySQL, and ClickHouse — so a write can't happen even if a check is wrong. Point Atlas at a least-privilege role for belt-and-suspenders.",
  },
  {
    id: "sandbox",
    title: "Sandboxed tool execution",
    // Execution-region disclosure per #4223 (ADR-0024 amendment 2026-07-16).
    // Remediation tracks: #4665 (BYOC Python), #4666 (per-region platform sandbox provider).
    legal: [
      "Beyond writing SQL, the agent can explore your semantic layer (ls, cat, grep, find) and, where enabled, run Python. These tools execute in an isolated sandbox — never directly on the host.",
      "On Atlas Cloud, the sandbox is a Vercel Sandbox: a Firecracker microVM with its network policy set to deny-all, so sandboxed code cannot make outbound connections. Self-hosted deployments get the same isolation through nsjail (Linux namespaces) or an isolated sidecar service, selected by a documented priority chain.",
      "One locality note: Vercel Sandbox provisions only in the United States (iad1), so on Atlas Cloud sandbox execution runs in the US regardless of your workspace's data-residency region. What transits is semantic-layer content — including sampled values — and, for Python, query-result rows, under the same deny-all networking and an ephemeral filesystem that persists nothing. This is disclosed in our sub-processor list; workspaces that need in-region execution can connect their own sandbox on a region-controlled provider, which always takes priority over the platform sandbox.",
      "Inside the sandbox, the explore tool has read-only access scoped to your semantic-layer directory and nothing else. There are no writes, no shell escapes, and path-traversal attempts outside the semantic directory are blocked. The agent's tools can read the map of your data — never your filesystem, your environment, or your database credentials.",
    ],
    plain:
      "The agent's file and Python tools run in a locked-down sandbox — a network-denied microVM on Cloud, nsjail or a sidecar when self-hosted — with read-only access to your semantic layer and nothing else. On Cloud, sandbox execution runs in the US (iad1) regardless of workspace region; bring your own sandbox for in-region execution.",
  },
  {
    id: "credentials",
    title: "Credentials encrypted at rest",
    legal: [
      "Connection strings, API keys, and integration secrets are encrypted at rest with AES-256-GCM. The format is versioned, so encryption keys can be rotated without re-encrypting existing data and old ciphertext stays readable during the rotation window.",
      "Encryption is selective and schema-driven: a field is encrypted when its config schema marks it secret: true, so credentials are protected while non-sensitive configuration stays queryable. Secret values are never returned in API responses — admin endpoints mask them, and a masked value sent back on save is swapped for the stored secret rather than overwriting it.",
      "On Atlas Cloud, every tenant's credentials are isolated and resolved only from the database — a workspace's plugin credentials never fall back to an operator's environment variables. One customer's connection can never be resolved with another's, or with ours.",
    ],
    plain:
      "Secrets are AES-256-GCM encrypted at rest with rotatable keys, masked in every API response, and isolated per tenant — a workspace's credentials never leak into logs, responses, or another tenant's context.",
  },
  {
    id: "verify",
    title: "Don't trust us — verify",
    legal: [
      "Every control on this page is implemented in the open-source Atlas codebase. The SQL validator, the read-only session setup, the sandbox priority chain, and the encryption helpers are all there to read, in the same repository the project ships from.",
      "Self-hosting is free and AGPL-3.0 licensed: run Atlas entirely in your own infrastructure, bring your own model key, and send no telemetry to us. Nothing in your data path has to touch Atlas DevHQ at all.",
      "If you find a security issue, report it to security@useatlas.dev. Our disclosure policy is published at useatlas.dev/.well-known/security.txt.",
    ],
    plain:
      "All of this is open source — read it, run it, audit it. Self-host on AGPL with your own model key and zero telemetry. Found a problem? security@useatlas.dev.",
  },
];

export default function SecurityPage() {
  return (
    <div className="relative min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-60 focus:rounded-md focus:bg-bg-raised focus:px-3 focus:py-2 focus:font-mono focus:text-sm focus:text-fg focus:ring-2 focus:ring-accent"
      >
        Skip to content
      </a>

      <StickyNav />
      <TopGlow />
      <Nav currentPage="/security" />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        {/* Hero */}
        <section className="mx-auto max-w-4xl px-6 pt-16 pb-10 text-center md:pt-24 md:pb-14">
          <p className="animate-fade-in-up delay-100 mb-4 font-mono text-xs tracking-widest text-accent uppercase">
            // security · defense in depth
          </p>
          <h1 className="animate-fade-in-up delay-200 text-3xl font-semibold tracking-tight text-fg md:text-5xl">
            Safe to point at your database.
          </h1>
          <p className="animate-fade-in-up delay-300 mx-auto mt-4 max-w-xl text-lg text-fg-muted">
            Atlas lets an AI write SQL against your production data. Here&rsquo;s
            every control that makes that a defensible decision &mdash; and where
            to read the code behind each one.
          </p>
          <div className="animate-fade-in-up delay-400 mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 font-mono text-[11px] tracking-wider text-fg-muted uppercase">
            <span>verifiable in open source</span>
            <span aria-hidden="true">·</span>
            <span>self-host on AGPL-3.0</span>
            <span aria-hidden="true">·</span>
            <span>disclosures: security@useatlas.dev</span>
          </div>
        </section>

        {/* Four pillars */}
        <section
          aria-labelledby="four-pillars-heading"
          className="mx-auto max-w-5xl px-6 pt-6 pb-4 md:pt-8"
        >
          <p
            id="four-pillars-heading"
            className="mb-3 font-mono text-xs tracking-widest text-accent uppercase"
          >
            // the four pillars
          </p>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PILLARS.map((p) => (
              <li
                key={p.mono}
                className="rounded-xl border border-accent/30 bg-accent-quiet p-5 md:p-6"
              >
                <p className="mb-3 font-mono text-[12px] tracking-wider text-accent">
                  {p.mono}
                </p>
                <p className="mb-2 text-[15px] leading-snug font-semibold text-fg">
                  {p.label}
                </p>
                <p className="text-[12.5px] leading-relaxed text-fg-muted">
                  {p.sub}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Detailed sections — TOC + dual-column body */}
        <section className="mx-auto max-w-7xl px-6 py-12 md:py-16">
          <div className="grid gap-12 lg:grid-cols-[220px_1fr] lg:gap-16">
            <LegalTOC sections={SECTIONS} />
            <article className="flex flex-col gap-12 md:gap-16">
              {SECTIONS.map((section, i) => (
                <LegalSection key={section.id} section={section} index={i} />
              ))}
            </article>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="mx-auto max-w-4xl px-6 py-16 text-center md:py-24">
          <h2 className="mb-3 text-2xl font-semibold tracking-tight text-fg md:text-3xl">
            Connect with confidence.
          </h2>
          <p className="mx-auto mb-6 max-w-xl text-fg-muted">
            Read the full technical breakdown of the validation pipeline, or
            self-host and audit every line yourself. Security questions and
            disclosures go to security@useatlas.dev.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="https://docs.useatlas.dev/security/sql-validation"
              className="group inline-flex items-center gap-2 rounded-lg bg-fg px-5 py-2.5 text-sm font-medium text-bg transition-all hover:bg-accent"
            >
              Read the SQL validation docs
            </a>
            <a
              href="mailto:security@useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-fg-muted transition-all hover:border-border-strong hover:text-fg"
            >
              Email security
            </a>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
