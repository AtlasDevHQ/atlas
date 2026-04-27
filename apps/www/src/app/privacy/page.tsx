import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { LegalSection, LegalTOC, type LegalSectionData } from "../../components/legal";
import { Nav } from "../../components/nav";
import { TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";

export const metadata: Metadata = {
  title: "Privacy Policy — Atlas",
  description:
    "What Atlas DevHQ collects, what it doesn't, and exactly what's done with it. Four promises up top, twelve sections below.",
  openGraph: {
    title: "Privacy Policy — Atlas",
    description:
      "Atlas Cloud privacy policy: what we collect, what we DON'T do (no model training, no selling data, no warehouse reads beyond authorized queries), GDPR / CCPA rights, sub-processors.",
    url: "https://www.useatlas.dev/privacy",
    siteName: "Atlas",
    type: "website",
  },
};

interface PromiseCard {
  mono: string;
  label: string;
  sub: string;
}

const PROMISES: PromiseCard[] = [
  {
    mono: "no_train",
    label: "We don’t train on your data",
    sub: "Not your queries, not your warehouse contents, not your prompts. Ever.",
  },
  {
    mono: "no_sell",
    label: "We don’t sell your data",
    sub: "No data brokers, no ad networks, no “partners.” Subscription fees are how we pay the bills.",
  },
  {
    mono: "no_warehouse_read",
    label: "We don’t read your warehouse",
    sub: "Queries run only when your users authorize them. Schema profiling samples a small set of rows — Customer-initiated, only to seed the semantic-layer YAML.",
  },
  {
    mono: "encrypted",
    label: "Encrypted in transit + at rest",
    sub: "TLS 1.2+ in flight. AES-256-GCM on disk with versioned key rotation. Per-customer KMS keys negotiable on enterprise contracts.",
  },
];

const SECTIONS: LegalSectionData[] = [
  {
    id: "intro",
    title: "Who we are & what this covers",
    legal: [
      'This Privacy Policy describes how Atlas DevHQ ("Atlas", "we") collects and processes personal information when you use Atlas Cloud, our website at useatlas.dev, our documentation, and related communications.',
      "It does not cover the open-source Atlas distribution that you self-host — when you run Atlas in your own infrastructure under AGPL-3.0, we don’t see your data and there is nothing for us to collect.",
      "If you are a Customer’s end user (e.g. someone whose company uses Atlas Cloud), the Customer is the controller of your personal data and you should consult their privacy policy. We process your data on the Customer’s behalf, as described in the Data Processing Addendum at useatlas.dev/dpa.",
    ],
    plain:
      "This describes Atlas Cloud only. If you self-host, your data never reaches us — nothing in this policy applies to that deployment.",
  },
  {
    id: "what",
    title: "What we collect",
    legal: [
      "Account data: name, email, organization, role, hashed password (or SSO subject identifier).",
      "Configuration data: semantic-layer YAML, validator rules, warehouse connection metadata (host, database, schema names — never credentials in plaintext).",
      "Operational data: query metadata (timestamp, gate outcomes, execution time, row count, error class). Query SQL and natural-language prompts are stored only when audit logging is enabled by the Customer admin.",
      "Telemetry: IP address, browser user-agent, page-load timing, error stack traces. Telemetry is sampled and retained for 30 days.",
      "Billing data: company name, billing address, tax ID, payment method tokens. We use Stripe as our payment processor; we never store full card numbers.",
    ],
    plain:
      "Account info, your configuration, query metadata (query text only when your admin enables audit logging), error and performance telemetry, and billing details handled by Stripe.",
  },
  {
    id: "why",
    title: "Why we collect it",
    legal: [
      "To provide the Service: authenticate users, execute queries, render dashboards, send transactional email.",
      "To improve the Service: aggregate, anonymized telemetry to find slow paths, broken flows, and common errors. We do not use Customer Data to train models.",
      "To bill you: process payments, send invoices, comply with tax law.",
      "To keep the Service safe: detect abuse, rate-limit attackers, investigate security incidents.",
      "To support you: respond to email, debug your issue with your explicit permission to read configuration data.",
    ],
    plain:
      "To operate the Service, improve it through aggregate telemetry, process payments, prevent abuse, and respond to support requests.",
  },
  {
    id: "no-train",
    title: "What we DO NOT do",
    legal: [
      "We do not use Customer Data — including queries, prompts, semantic-layer definitions, and any data returned from your warehouse — to train, fine-tune, or evaluate AI models.",
      "We do not sell or rent personal data to third parties.",
      "We do not share personal data with advertising networks.",
      "We do not access Customer’s data warehouse content for any purpose other than (a) executing queries that Customer’s authorized users have explicitly issued, and (b) the Customer-initiated schema profiling step (`atlas init` or the Connect Wizard) which samples a small set of rows from each table to seed the semantic-layer YAML. Profiling does not run on a recurring basis — only when the Customer adds or refreshes a connection.",
      "We do not retain query result sets in persistent storage; results live in encrypted memory for the duration of a session and are evicted within minutes of the session ending.",
    ],
    plain:
      "Five commitments, each one expanded above: no training on Customer Data, no selling, no ad-network sharing, no warehouse reads beyond authorized queries (with one Customer-initiated carve-out for first-time schema profiling), no persistent result-set storage.",
  },
  {
    id: "share",
    title: "Who we share with",
    legal: [
      "Sub-processors: a small set of vendors that help us run the Service (cloud infrastructure, error monitoring, payment processing). The current list is published at useatlas.dev/dpa and customers receive 30 days’ notice of additions.",
      "Model providers: when Customer uses Atlas’s hosted models, prompts are routed through Vercel AI Gateway, which forwards them to the upstream model provider configured for that Customer (e.g. Anthropic, OpenAI). Vercel acts as a sub-processor for routing, observability, and fallback. Where Customer uses BYO model keys, traffic is sent directly to the provider Customer specifies and does not transit Vercel.",
      "Legal: we may disclose information when required by law, court order, or to protect our rights, with notice to Customer where legally permitted.",
      "Successors: in a merger or sale of substantially all assets, the acquirer takes on the same obligations under this Policy.",
    ],
    plain:
      "A short list of operational vendors (cloud infra, error monitoring, payments), the model provider you select, and disclosures required by valid legal process.",
  },
  {
    id: "rights",
    title: "Your rights (GDPR, CCPA & similar)",
    legal: [
      "Depending on your location, you may have rights to access, correct, delete, port, or restrict processing of your personal data, and to object to certain processing. California residents have rights under the CCPA including the right to know, the right to delete, and the right to opt out of any sale of personal information (Atlas does not sell personal information). To exercise these rights, email privacy@useatlas.dev.",
      "If you are a Customer’s end user, please contact the Customer first; we will assist them in responding within 30 days.",
      "You have the right to lodge a complaint with a data protection authority. We hope you’ll give us a chance to resolve it first.",
    ],
    plain:
      "Email privacy@useatlas.dev to exercise access, correction, deletion, or other rights. We respond within 30 days. CCPA + GDPR rights both honored from the same intake.",
  },
  {
    id: "transfers",
    title: "International transfers",
    legal: [
      "Atlas Cloud is hosted in three Customer-selectable regions on the Business plan: United States (Ashburn, Virginia), Europe (Eemshaven, Netherlands), and Asia Pacific (Singapore). Customer Data does not leave the selected region except for transactional services (billing, status email) which are processed in the United States.",
      "Where personal data is transferred from the EEA, UK, or Switzerland to the US, we rely on Standard Contractual Clauses and the EU-US Data Privacy Framework where available. Custom enterprise contracts can negotiate additional regions.",
    ],
    plain:
      "Customer Data stays in the region you select (United States, Europe, or Asia Pacific on Business). Billing and outbound email are processed in the US under Standard Contractual Clauses where applicable.",
  },
  {
    id: "retention",
    title: "Retention",
    legal: [
      "Account data: retained for the duration of the account plus 90 days after closure.",
      "Audit logs: 365 days by default on Business; configurable per-workspace with a 7-day floor and a hard-delete delay for compliance export.",
      "Telemetry: 30 days, then aggregated and de-identified.",
      "Backups: production data is retained in encrypted backups for up to 90 days.",
    ],
    plain:
      "Account data: term + 90 days. Audit logs: 365 days by default, configurable per-workspace (7-day floor). Telemetry: 30 days then aggregated. Encrypted backups: up to 90 days.",
  },
  {
    id: "security",
    title: "Security",
    legal: [
      "Atlas maintains a security program aligned with ISO 27001 and SOC 2 Type II controls. Highlights: TLS 1.2+ in transit, AES-256-GCM at rest with versioned key rotation, least-privilege IAM, encrypted internal-database storage of all integration credentials and connection strings, and automated vulnerability scanning of container images and dependencies. Two-factor authentication for admin accounts and per-customer KMS keys are on the public roadmap and negotiable on enterprise contracts.",
      "Suspected security incidents may be reported to security@useatlas.dev. Our disclosure policy is published at useatlas.dev/.well-known/security.txt (RFC 9116). A PGP key is available on request.",
    ],
    plain:
      "TLS 1.2+ in transit, AES-256-GCM at rest with versioned key rotation, least-privilege IAM. Working toward formal SOC 2 Type II + ISO 27001 certifications and admin MFA. Report suspected issues to security@useatlas.dev (PGP key on request).",
  },
  {
    id: "cookies",
    title: "Cookies & tracking",
    legal: [
      "We use first-party cookies on Atlas Cloud for authentication and CSRF protection. The marketing site at useatlas.dev currently runs no analytics or behavioral tracking — no Plausible, no Google Analytics, no third-party advertising pixels, no cross-site cookies.",
      "You can disable cookies in your browser; some Service features (notably login on Atlas Cloud) will not work without them.",
    ],
    plain:
      "First-party auth + CSRF cookies on Atlas Cloud. Zero analytics or advertising tracking on the marketing site. Disabling cookies prevents sign-in.",
  },
  {
    id: "kids",
    title: "Children",
    legal: [
      "The Service is not intended for individuals under 16. We do not knowingly collect personal data from children. If you believe a child has provided us personal data, contact privacy@useatlas.dev and we will delete it.",
    ],
    plain:
      "The Service is not intended for users under 16. Contact privacy@useatlas.dev if a child has submitted personal data and we will delete it.",
  },
  {
    id: "changes",
    title: "Changes",
    legal: [
      "We may update this Policy. Material changes will be announced by email to account admins and posted on this page with an updated effective date at least 30 days before taking effect.",
    ],
    plain:
      "Material changes are announced to account admins by email at least 30 days before taking effect.",
  },
];

export default function PrivacyPage() {
  return (
    <div className="relative min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-60 focus:rounded-md focus:bg-zinc-900 focus:px-3 focus:py-2 focus:font-mono focus:text-sm focus:text-zinc-100 focus:ring-2 focus:ring-brand"
      >
        Skip to content
      </a>

      <StickyNav />
      <TopGlow />
      <Nav currentPage="/privacy" />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        {/* Hero */}
        <section className="mx-auto max-w-4xl px-6 pt-16 pb-10 text-center md:pt-24 md:pb-14">
          <p className="animate-fade-in-up delay-100 mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
            // legal · privacy
          </p>
          <h1 className="animate-fade-in-up delay-200 text-3xl font-semibold tracking-tight text-zinc-100 md:text-5xl">
            Privacy Policy.
          </h1>
          <p className="animate-fade-in-up delay-300 mx-auto mt-4 max-w-xl text-lg text-zinc-400">
            What we collect, what we don&rsquo;t, and exactly what we do with
            it. Aggressively boring on purpose.
          </p>
          <div className="animate-fade-in-up delay-400 mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 font-mono text-[11px] tracking-wider text-zinc-400 uppercase">
            <span>effective 2026-01-15</span>
            <span aria-hidden="true">·</span>
            <span>v3.0</span>
            <span aria-hidden="true">·</span>
            <span>questions: privacy@useatlas.dev</span>
          </div>
        </section>

        {/* Four promises */}
        <section
          aria-labelledby="four-promises-heading"
          className="mx-auto max-w-5xl px-6 pt-6 pb-4 md:pt-8"
        >
          <p
            id="four-promises-heading"
            className="mb-3 font-mono text-xs tracking-widest text-brand/80 uppercase"
          >
            // the four promises
          </p>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PROMISES.map((p) => (
              <li
                key={p.mono}
                className="rounded-xl border border-brand/30 bg-brand/4 p-5 md:p-6"
              >
                <p className="mb-3 font-mono text-[12px] tracking-wider text-brand">
                  {p.mono}
                </p>
                <p className="mb-2 text-[15px] leading-snug font-semibold text-zinc-100">
                  {p.label}
                </p>
                <p className="text-[12.5px] leading-relaxed text-zinc-400">
                  {p.sub}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* Legal sections — TOC + dual-column body */}
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
          <h2 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
            Privacy questions?
          </h2>
          <p className="mx-auto mb-6 max-w-xl text-zinc-400">
            Email privacy for data-rights requests, security for suspected
            incidents, or sales for negotiated DPAs on enterprise contracts.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="mailto:privacy@useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-white"
            >
              Email privacy
            </a>
            <a
              href="mailto:security@useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100"
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

