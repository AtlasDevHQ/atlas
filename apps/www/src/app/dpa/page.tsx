import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { LegalSection, LegalTOC, type LegalSectionData } from "../../components/legal";
import { Nav } from "../../components/nav";
import { ArrowIcon, TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";

export const metadata: Metadata = {
  title: "Data Processing Addendum — Atlas",
  description:
    "Atlas Cloud Article 28 GDPR-compliant DPA, with the EU Standard Contractual Clauses incorporated by reference. Pre-signed via legal@useatlas.dev — no negotiation needed for standard deals.",
  openGraph: {
    title: "Data Processing Addendum — Atlas",
    description:
      "Article 28 GDPR DPA + SCCs by reference + sub-processors annex + subscribe-to-changes for procurement.",
    url: "https://www.useatlas.dev/dpa",
    siteName: "Atlas",
    type: "website",
  },
};

interface SubProcessor {
  name: string;
  purpose: string;
  region: string;
  since: string;
}

const SUBPROCESSORS: SubProcessor[] = [
  {
    name: "Railway",
    purpose: "Cloud infrastructure (compute, storage, Postgres)",
    region: "Customer’s selected region (US East, EU West, APAC SE)",
    since: "2026-01",
  },
  {
    name: "Stripe",
    purpose: "Payment processing",
    region: "United States",
    since: "2026-01",
  },
  {
    name: "Anthropic",
    purpose: "Hosted model inference (default + opt-in)",
    region: "United States",
    since: "2026-01",
  },
  {
    name: "OpenAI",
    purpose: "Hosted model inference (opt-in)",
    region: "United States",
    since: "2026-01",
  },
  {
    name: "Resend",
    purpose: "Transactional email (receipts, alerts, invitations)",
    region: "United States",
    since: "2026-01",
  },
  {
    name: "OpenStatus",
    purpose: "External uptime monitoring + status page",
    region: "European Union",
    since: "2026-01",
  },
  {
    name: "Plausible",
    purpose:
      "First-party analytics on the marketing site only (no IP storage, no Customer Data)",
    region: "European Union",
    since: "2026-01",
  },
];

const SECTIONS: LegalSectionData[] = [
  {
    id: "scope",
    title: "Scope & Roles",
    legal: [
      'This Data Processing Addendum ("DPA") supplements the Atlas Terms of Service or any signed master agreement (the "Agreement") between Atlas DevHQ ("Processor") and the Customer ("Controller").',
      "Where Customer is itself a processor for its end users, Atlas acts as a sub-processor; the terms of this DPA apply with equivalent force.",
      "In case of conflict between the Agreement and this DPA, this DPA controls for the processing of Personal Data.",
    ],
    plain:
      "You act as Controller; Atlas acts as Processor. This addendum governs how we handle personal data on your behalf.",
  },
  {
    id: "details",
    title: "Processing Details (Art. 28(3) GDPR)",
    legal: [
      "Subject matter: provision of the Atlas Cloud text-to-SQL service.",
      "Duration: for the term of the Agreement plus the retention periods set out in the Privacy Policy.",
      "Nature & purpose: storing semantic-layer configuration; routing queries between Customer’s authorized users, model providers, and Customer’s data warehouse; producing audit logs.",
      "Categories of data subjects: Customer’s employees, contractors, and any individuals whose data resides in Customer’s data warehouse and is returned in query results.",
      "Categories of personal data: identifiers (name, email, SSO subject), business contact info, query text and results when audit logging is enabled, IP addresses, device metadata.",
      "Atlas does not process special categories of personal data (Art. 9 GDPR) on Customer’s behalf in the ordinary course. Customer is responsible for not submitting such data without notifying Atlas in writing.",
    ],
    plain:
      "Required by Art. 28(3) GDPR. Subject matter, duration, nature, purpose, and categories of data and data subjects all specified above.",
  },
  {
    id: "obligations",
    title: "Processor Obligations",
    legal: [
      "Atlas processes Personal Data only on documented instructions from Customer (the Agreement, this DPA, and Customer’s reasonable written instructions thereafter), unless required to do otherwise by EU/EEA/UK law (in which case Atlas notifies Customer unless prohibited).",
      "Atlas ensures that personnel authorized to process Personal Data are bound by appropriate confidentiality obligations.",
      "Atlas implements the technical and organizational measures listed in Annex II.",
      "Atlas assists Customer in responding to data-subject requests (access, rectification, erasure, restriction, portability, objection) by providing tools and reasonable cooperation.",
      "Atlas assists Customer with DPIAs and prior consultations (Art. 35–36 GDPR) by providing relevant information about the Service.",
    ],
    plain:
      "We process only on your documented instructions. Personnel are bound by confidentiality. We maintain the controls in Annex II and assist with data-subject requests and DPIAs.",
  },
  {
    id: "subprocessors",
    title: "Sub-processors",
    legal: [
      "Customer authorizes Atlas to engage the sub-processors listed in Annex I (rendered as a table at the bottom of this page), provided that Atlas: (a) imposes data-protection obligations on each sub-processor that are equivalent to those in this DPA; (b) remains liable for the acts and omissions of its sub-processors as for its own.",
      "Atlas notifies Customer at least 30 days before adding or replacing a sub-processor. Customer may object on reasonable, documented data-protection grounds within that period; if the parties cannot agree, Customer may terminate the affected portion of the Service for cause and receive a pro-rata refund.",
    ],
    plain:
      "Annex I (below) lists current sub-processors. We provide 30 days’ notice before adding or replacing one, and you may object on documented data-protection grounds.",
  },
  {
    id: "transfers",
    title: "International Transfers",
    legal: [
      "Where Personal Data originating in the EEA, the United Kingdom, or Switzerland is transferred to a country not subject to an adequacy decision, the EU Standard Contractual Clauses (Module Two: controller-to-processor; Module Three: processor-to-processor where Customer is itself a processor) are incorporated by reference, with the docking clause and option clauses completed in Annex III.",
      "For UK transfers, the UK International Data Transfer Addendum issued by the ICO is incorporated. For Swiss transfers, equivalent supplementary measures apply.",
    ],
    plain:
      "Transfers from the EEA, UK, or Switzerland to non-adequate jurisdictions are governed by the Standard Contractual Clauses, incorporated by reference — no separate signature required.",
  },
  {
    id: "security",
    title: "Security Incidents",
    legal: [
      "Atlas notifies Customer without undue delay, and in any event within 48 hours, after becoming aware of a Personal Data Breach affecting Customer Data, providing the information required by Art. 33(3) GDPR to the extent then known.",
      "Atlas updates Customer as facts develop and cooperates with Customer in remediating the breach and notifying affected data subjects or supervisory authorities where required.",
    ],
    plain:
      "We notify you of any Personal Data Breach without undue delay and within 48 hours, with the information Art. 33(3) GDPR requires, and cooperate on remediation.",
  },
  {
    id: "audit",
    title: "Audits",
    legal: [
      "Atlas makes available to Customer all information necessary to demonstrate compliance with Art. 28 GDPR, including its current SOC 2 Type II report and ISO 27001 certificate where applicable. Reports are available on request under appropriate confidentiality terms.",
      "Once per twelve-month period, on at least 30 days’ notice and during normal business hours, Customer may conduct, or have a third party conduct under appropriate confidentiality, an audit of Atlas’s processing activities, limited to information reasonably necessary to verify compliance and conducted in a manner that does not unreasonably interfere with Atlas’s operations.",
    ],
    plain:
      "We share our SOC 2 Type II report and ISO 27001 certificate on request. You may audit our processing once per year with 30 days’ notice and confidentiality protections.",
  },
  {
    id: "deletion",
    title: "Return & Deletion",
    legal: [
      "On termination of the Agreement, Atlas will, at Customer’s election, return or delete all Personal Data within 90 days, except to the extent applicable law requires retention. Encrypted backups are deleted within an additional 90 days as part of the standard backup-rotation cycle.",
      "Atlas will provide written confirmation of deletion on request.",
    ],
    plain:
      "On termination we return or delete your data within 90 days; encrypted backups within an additional 90. Written confirmation on request.",
  },
  {
    id: "annex",
    title: "Annexes",
    legal: [
      "Annex I — List of Sub-processors. The current list is rendered as a table at the bottom of this page and is the source of truth.",
      "Annex II — Technical and Organizational Measures: encryption (TLS 1.2+ in transit, AES-256 at rest), customer-managed KMS keys negotiable on enterprise contracts, MFA-required admin access, least-privilege IAM, audit logging of administrative operations, automated vulnerability scanning, annual third-party penetration testing, ISO 27001-aligned ISMS, SOC 2 Type II reported annually, secure SDLC with mandatory code review, segregated production access, documented incident-response runbook with quarterly drills.",
      "Annex III — Standard Contractual Clauses, Module Two (controller-to-processor) selected by default. Optional Clause 7 (Docking Clause) is included. Clause 9 sub-processor option (b) — general written authorization with 30-day notice — applies. Clause 11 dispute-resolution option (a) is selected. Clause 17 governing law: Ireland. Clause 18 forum: Ireland.",
    ],
    plain:
      "Annex I lists current sub-processors. Annex II details our security controls. Annex III incorporates the EU SCCs (Module Two), with Ireland as governing law and forum.",
  },
];

export default function DPAPage() {
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
      <Nav currentPage="/dpa" />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        {/* Hero */}
        <section className="mx-auto max-w-4xl px-6 pt-16 pb-10 text-center md:pt-24 md:pb-14">
          <p className="animate-fade-in-up delay-100 mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
            // legal · dpa
          </p>
          <h1 className="animate-fade-in-up delay-200 text-3xl font-semibold tracking-tight text-zinc-100 md:text-5xl">
            Data Processing Addendum.
          </h1>
          <p className="animate-fade-in-up delay-300 mx-auto mt-4 max-w-xl text-lg text-zinc-400">
            Article 28 GDPR-compliant DPA, with the EU Standard Contractual
            Clauses incorporated by reference. Pre-signed for standard deals —
            no negotiation needed.
          </p>
          <div className="animate-fade-in-up delay-400 mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 font-mono text-[11px] tracking-wider text-zinc-400 uppercase">
            <span>effective 2026-01-15</span>
            <span aria-hidden="true">·</span>
            <span>v2.4</span>
            <span aria-hidden="true">·</span>
            <span>incorporates: SCCs (2021/914), UK IDTA</span>
          </div>
        </section>

        {/* Pre-signed request card */}
        <section
          aria-labelledby="presigned-heading"
          className="mx-auto max-w-5xl px-6 pt-6 pb-4 md:pt-8"
        >
          <p
            id="presigned-heading"
            className="mb-3 font-mono text-xs tracking-widest text-brand/80 uppercase"
          >
            // pre-signed
          </p>
          <div className="rounded-2xl border border-brand/30 bg-brand/4 p-5 md:p-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
              <div>
                <p className="mb-1 font-mono text-[15px] font-semibold text-zinc-100 md:text-base">
                  DPA-v2.4-pre-signed.pdf
                </p>
                <p className="font-mono text-[11px] tracking-wider text-zinc-400">
                  Countersigned by Atlas · valid through 2027-01-15 ·
                  available on request
                </p>
              </div>
              <a
                href="mailto:legal@useatlas.dev?subject=DPA%20countersigned%20PDF%20request"
                className="group inline-flex shrink-0 items-center gap-2 self-start rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-brand-hover md:self-auto"
              >
                Request countersigned PDF
                <ArrowIcon />
              </a>
            </div>
          </div>
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

        {/* Annex I — Sub-processors */}
        <section
          id="annex-i-subprocessors"
          aria-labelledby="annex-i-heading"
          className="mx-auto max-w-7xl px-6 py-12 md:py-16"
        >
          <div className="mb-8 flex flex-col items-start gap-6 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
            <div>
              <p className="mb-3 font-mono text-xs tracking-widest text-brand/80 uppercase">
                // annex i — sub-processors
              </p>
              <h2
                id="annex-i-heading"
                className="text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl"
              >
                Current sub-processors.
              </h2>
              <p className="mt-2 max-w-xl text-sm text-zinc-400">
                This list is the source of truth. We notify Customer at least
                30 days before any addition or replacement.
              </p>
            </div>

            <div className="w-full max-w-sm rounded-xl border border-brand/30 bg-brand/4 p-5">
              <p className="mb-3 font-mono text-[10px] tracking-widest text-brand uppercase">
                // subscribe to changes
              </p>
              <p className="mb-3 text-[13px] leading-relaxed text-zinc-400">
                We email account admins automatically. Procurement teams can
                add a separate distribution list:
              </p>
              <a
                href="mailto:legal@useatlas.dev?subject=Subscribe%20to%20sub-processor%20notifications&body=Please%20add%20the%20following%20address%20to%20the%20sub-processor%20notification%20list%3A%0A"
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-zinc-950 transition-colors hover:bg-brand-hover"
              >
                Subscribe via email
                <ArrowIcon />
              </a>
            </div>
          </div>

          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-xl border border-zinc-800/60 md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-800/60 bg-zinc-900/50">
                  <th
                    scope="col"
                    className="px-5 py-4 text-left font-mono text-[11px] tracking-widest text-zinc-400 uppercase"
                  >
                    vendor
                  </th>
                  <th
                    scope="col"
                    className="px-5 py-4 text-left font-mono text-[11px] tracking-widest text-zinc-400 uppercase"
                  >
                    purpose
                  </th>
                  <th
                    scope="col"
                    className="px-5 py-4 text-left font-mono text-[11px] tracking-widest text-zinc-400 uppercase"
                  >
                    region
                  </th>
                  <th
                    scope="col"
                    className="px-5 py-4 text-left font-mono text-[11px] tracking-widest text-zinc-400 uppercase"
                  >
                    since
                  </th>
                </tr>
              </thead>
              <tbody>
                {SUBPROCESSORS.map((sp) => (
                  <tr
                    key={sp.name}
                    className="border-b border-zinc-800/30 last:border-0"
                  >
                    <td className="px-5 py-3.5 text-sm font-semibold text-zinc-100">
                      {sp.name}
                    </td>
                    <td className="px-5 py-3.5 text-sm text-zinc-300">
                      {sp.purpose}
                    </td>
                    <td className="px-5 py-3.5 text-sm text-zinc-300">
                      {sp.region}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-xs text-zinc-400">
                      {sp.since}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile / tablet — stacked cards */}
          <ul className="space-y-4 md:hidden">
            {SUBPROCESSORS.map((sp) => (
              <li
                key={sp.name}
                className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-5"
              >
                <p className="mb-2 text-sm font-semibold text-zinc-100">
                  {sp.name}
                </p>
                <p className="mb-3 text-sm text-zinc-300">{sp.purpose}</p>
                <div className="flex items-center justify-between font-mono text-[11px] tracking-wider text-zinc-400">
                  <span>{sp.region}</span>
                  <span>{sp.since}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Closing CTA */}
        <section className="mx-auto max-w-4xl px-6 py-16 text-center md:py-24">
          <h2 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
            Procurement questions?
          </h2>
          <p className="mx-auto mb-6 max-w-xl text-zinc-400">
            For DPA negotiation, custom enterprise terms, or audit-package
            requests (SOC 2, ISO 27001, pen-test summary), reach out to legal
            or sales.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="mailto:legal@useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-white"
            >
              Email legal
            </a>
            <a
              href="mailto:sales@useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100"
            >
              Talk to sales
            </a>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
