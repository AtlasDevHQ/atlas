import type { Metadata } from "next";

import { Footer } from "../../components/footer";
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

interface Promise {
  mono: string;
  label: string;
  sub: string;
}

const PROMISES: Promise[] = [
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
    sub: "Atlas runs queries you authorize. We don’t browse, sample, or index your tables.",
  },
  {
    mono: "encrypted",
    label: "Encrypted in transit + at rest",
    sub: "TLS 1.2+ in flight. AES-256 on disk. Per-customer KMS keys negotiable on enterprise contracts.",
  },
];

interface LegalSection {
  id: string;
  title: string;
  legal: string[];
  plain: string;
}

const SECTIONS: LegalSection[] = [
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
      "We do not access Customer’s data warehouse content for any purpose other than executing queries that Customer’s authorized users have explicitly issued.",
      "We do not retain query result sets in persistent storage; results live in encrypted memory for the duration of a session and are evicted within minutes of the session ending.",
    ],
    plain:
      "Five commitments, each one expanded above: no training on Customer Data, no selling, no ad-network sharing, no warehouse reads beyond authorized queries, no persistent result-set storage.",
  },
  {
    id: "share",
    title: "Who we share with",
    legal: [
      "Sub-processors: a small set of vendors that help us run the Service (cloud infrastructure, error monitoring, payment processing). The current list is published at useatlas.dev/dpa and customers receive 30 days’ notice of additions.",
      "Model providers: when Customer uses Atlas’s hosted models, prompts are sent to the model provider configured for that Customer (e.g. Anthropic, OpenAI). Where Customer uses BYO model keys, traffic is sent directly to the provider Customer specifies.",
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
      "Atlas Cloud is hosted in three Customer-selectable regions on the Business plan: us-east-1 (Virginia), eu-west-1 (Ireland), and ap-southeast-2 (Sydney). Customer Data does not leave the selected region except for transactional services (auth, billing, status email) which are processed in the United States.",
      "Where personal data is transferred from the EEA, UK, or Switzerland to the US, we rely on Standard Contractual Clauses and the EU-US Data Privacy Framework where available. Custom enterprise contracts can negotiate additional regions.",
    ],
    plain:
      "Customer Data stays in the region you select (US East, EU West, or APAC Southeast on Business). Auth and billing are processed in the US under Standard Contractual Clauses where applicable.",
  },
  {
    id: "retention",
    title: "Retention",
    legal: [
      "Account data: retained for the duration of the account plus 90 days after closure.",
      "Audit logs: retained for the period configured by the Customer admin (default 365 days on Business; configurable per-workspace).",
      "Telemetry: 30 days, then aggregated and de-identified.",
      "Backups: production data is retained in encrypted backups for up to 90 days.",
    ],
    plain:
      "Account data: term + 90 days. Audit logs: 365 days by default, configurable. Telemetry: 30 days then aggregated. Encrypted backups: up to 90 days.",
  },
  {
    id: "security",
    title: "Security",
    legal: [
      "Atlas maintains a security program based on ISO 27001 and SOC 2 Type II controls. Highlights: TLS 1.2+ in transit, AES-256 at rest, MFA-required admin access, least-privilege IAM, automated vulnerability scanning, and external penetration tests at least annually. Per-customer KMS keys are negotiable on enterprise contracts.",
      "Suspected security incidents may be reported to security@useatlas.dev; PGP key published at useatlas.dev/.well-known/security.txt.",
    ],
    plain:
      "TLS 1.2+ in transit, AES-256 at rest, MFA-required admin access, annual third-party pen tests. Report suspected issues to security@useatlas.dev.",
  },
  {
    id: "cookies",
    title: "Cookies & tracking",
    legal: [
      "We use first-party cookies for authentication and CSRF protection. We use a single first-party analytics tool (Plausible, EU-hosted, no IP storage) on the marketing site. We do not use third-party advertising or behavioral tracking.",
      "You can disable cookies in your browser; some Service features (notably login) will not work without them.",
    ],
    plain:
      "First-party cookies for auth and CSRF protection plus EU-hosted, IP-free analytics on the marketing site. No advertising or behavioral cookies. Disabling cookies prevents sign-in.",
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
            <aside aria-label="Document contents" className="lg:sticky lg:top-24 lg:self-start">
              <p className="mb-4 font-mono text-[11px] tracking-widest text-brand uppercase">
                // contents
              </p>
              <ol className="space-y-1">
                {SECTIONS.map((section, i) => (
                  <li key={section.id}>
                    <a
                      href={`#${section.id}`}
                      className="-ml-3.5 flex items-baseline gap-2.5 border-l-2 border-transparent py-1.5 pl-3 text-[13px] text-zinc-400 transition-colors hover:border-brand/60 hover:text-brand"
                    >
                      <span className="font-mono text-[10px] tracking-wider text-zinc-400">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span>{section.title}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </aside>

            <article className="flex flex-col gap-12 md:gap-16">
              {SECTIONS.map((section, i) => (
                <PrivacyLegalSection key={section.id} section={section} index={i} />
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

function PrivacyLegalSection({ section, index }: { section: LegalSection; index: number }) {
  return (
    <section id={section.id} aria-labelledby={`${section.id}-heading`} className="scroll-mt-24">
      <div className="mb-6 flex items-baseline gap-4 border-b border-zinc-800/40 pb-4">
        <span className="font-mono text-[13px] tracking-wider text-brand">
          {String(index + 1).padStart(2, "0")}
        </span>
        <h2
          id={`${section.id}-heading`}
          className="text-xl font-semibold tracking-tight text-zinc-100 md:text-2xl"
        >
          {section.title}
        </h2>
      </div>
      <div className="grid gap-8 md:grid-cols-[1fr_280px] md:gap-10">
        <div className="space-y-4 text-[14.5px] leading-7 text-zinc-300">
          {section.legal.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
        <aside className="border-l border-dashed border-zinc-700/60 pl-6">
          <p className="mb-3 font-mono text-[10.5px] tracking-widest text-brand uppercase">
            // plain english
          </p>
          <p className="text-[13px] leading-6 text-zinc-400">{section.plain}</p>
        </aside>
      </div>
    </section>
  );
}
