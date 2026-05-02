import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { LegalSection, LegalTOC, type LegalSectionData } from "../../components/legal";
import { Nav } from "../../components/nav";
import { TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";

export const metadata: Metadata = {
  title: "Acceptable Use Policy — Atlas",
  description:
    "What you can't do with Atlas Cloud. Four prohibited categories up top, nine sections below — short, specific, and enforceable.",
  openGraph: {
    title: "Acceptable Use Policy — Atlas",
    description:
      "Atlas Cloud Acceptable Use Policy: prohibited uses, security-research carve-outs, customer-data responsibilities, and how violations are handled.",
    url: "https://www.useatlas.dev/aup",
    siteName: "Atlas",
    type: "website",
  },
};

interface ProhibitionCard {
  mono: string;
  label: string;
  sub: string;
}

const PROHIBITIONS: ProhibitionCard[] = [
  {
    mono: "no_illegal",
    label: "Don’t use Atlas to break the law",
    sub: "Or to violate someone else’s rights. That includes IP, privacy, and export-control rules.",
  },
  {
    mono: "no_abuse",
    label: "Don’t abuse shared infrastructure",
    sub: "No DDoS, no scraping the product, no rate-limit evasion, no degrading performance for other customers.",
  },
  {
    mono: "no_unauth_probe",
    label: "Don’t probe without permission",
    sub: "Security testing is welcome — email security@useatlas.dev first. Unannounced probing is not.",
  },
  {
    mono: "no_compete_on_ee",
    label: "Don’t build a competing hosted product on /ee",
    sub: "The commercial /ee directory is licensed for your use — not for relaunching as your own SaaS.",
  },
];

const SECTIONS: LegalSectionData[] = [
  {
    id: "scope",
    title: "Scope",
    legal: [
      'This Acceptable Use Policy ("AUP") sets out the activities prohibited on Atlas Cloud ("the Service") and on the public Atlas websites at useatlas.dev. It is part of the Terms of Service at useatlas.dev/terms and is incorporated by reference; capitalized terms not defined here have the meaning given in those Terms.',
      "This AUP does not apply to the open-source Atlas distribution that you self-host. When you run Atlas in your own infrastructure under AGPL-3.0, your acceptable use is governed by the license, your own internal policies, and applicable law — Atlas DevHQ has no enforcement role.",
      "If you discover a violation by another user, please report it to security@useatlas.dev with as much detail as you can share. We treat reports confidentially.",
    ],
    plain:
      "Applies to Atlas Cloud and useatlas.dev. Doesn’t apply to self-hosted Atlas (your infra, your rules). Report violations to security@useatlas.dev.",
  },
  {
    id: "prohibited",
    title: "Prohibited Uses",
    legal: [
      "You agree not to use the Service to: (a) violate any applicable law, regulation, or court order, or any third party’s intellectual-property, privacy, publicity, or contract rights; (b) transmit, store, or generate malware, viruses, ransomware, exploits, command-and-control payloads, or any code intended to disable, surveil, or damage another system; (c) generate or distribute child sexual abuse material, content depicting non-consensual sexual conduct, or content that incites violence against a protected class; (d) conduct fraud, phishing, identity theft, or social-engineering campaigns against third parties; (e) circumvent export controls or sanctions, including by routing prompts on behalf of sanctioned persons or jurisdictions; (f) misrepresent the source of a query, prompt, or generated artifact in a way intended to deceive the recipient about its origin.",
      "Atlas does not pre-screen Customer Data, prompts, or query results. Compliance with this Section is the Customer’s responsibility.",
    ],
    plain:
      "No illegal activity. No malware. No CSAM or non-consensual sexual content. No fraud or phishing. No sanctions evasion. No misrepresenting AI-generated content as human-authored when it would deceive the recipient.",
  },
  {
    id: "customer-data",
    title: "Customer-Data Responsibilities",
    legal: [
      "You are responsible for ensuring you have the legal right to submit any Customer Data (including warehouse contents that surface in query results) to the Service. This includes obtaining any required consents, providing required notices, and honoring any applicable contractual restrictions.",
      "Special categories of personal data under GDPR Art. 9 (e.g. health, biometric, sexual-orientation, political-opinion data) and protected health information under HIPAA may not be submitted to the Service unless Customer has notified Atlas in writing in advance and the parties have signed appropriate supplementary terms.",
      "You may not submit data that is, to your knowledge, unlawful for you to disclose — for example, data covered by an active legal hold belonging to a third party, or trade secrets that you do not have authorization to share with a processor.",
    ],
    plain:
      "You can only submit data you have the right to submit. No GDPR special-category data or HIPAA-protected health information without prior written agreement. No third-party data you’re not authorized to share.",
  },
  {
    id: "security-research",
    title: "Security Research & Testing",
    legal: [
      "Unauthorized security testing, vulnerability scanning, fuzzing, and probing of the Service is prohibited. This includes automated tooling pointed at app.useatlas.dev, api.useatlas.dev, the regional API endpoints, and any sub-domain of useatlas.dev.",
      "Atlas welcomes coordinated security research. Email security@useatlas.dev with the scope of testing you want to conduct, the source IP ranges you’ll test from, and a window. We respond within five business days. Our published disclosure policy is at www.useatlas.dev/.well-known/security.txt (RFC 9116).",
      "Findings reported in good faith under this Section, and within an authorized scope, will not be the basis of any legal action by Atlas. Atlas does not currently operate a paid bug-bounty program.",
    ],
    plain:
      "Don’t probe us without asking first. Email security@useatlas.dev to coordinate testing — we’ll respond within 5 business days. Good-faith research within scope is safe-harbored. No paid bounty (yet).",
  },
  {
    id: "competitive",
    title: "Competitive Use of /ee",
    legal: [
      "Atlas’s open-source distribution is licensed under AGPL-3.0; the source-available commercial features in the `/ee` directory are licensed under the separate Atlas Commercial License at github.com/AtlasDevHQ/atlas/blob/main/ee/LICENSE.",
      "You may not use the Service, or any code in the `/ee` directory of the Atlas repository, to develop, market, or operate a hosted product that substitutes for Atlas Cloud. Internal use, customer use, embedding via the SDK, and contribution back to upstream are not affected.",
    ],
    plain:
      "You can use the Service for anything except building a competing hosted version of Atlas on top of our /ee features. Self-host all you want; just don’t resell it.",
  },
  {
    id: "infrastructure",
    title: "Infrastructure Abuse",
    legal: [
      "You may not: (a) intentionally or negligently exceed published rate limits in a way that degrades performance for other customers; (b) submit prompts or queries designed to consume resources without producing useful output (e.g. infinite-loop prompts, prompts crafted to maximize token usage without legitimate purpose); (c) operate the Service in a way that materially increases Atlas’s upstream model-provider costs without commensurate Customer use; (d) automate signups or trial accounts to evade plan limits.",
      "Atlas applies rate limits and quotas to protect Service availability. Where automated enforcement is not sufficient, Atlas may contact Customer to discuss usage, and may suspend access in extreme cases as set out in Section 8.",
    ],
    plain:
      "Don’t intentionally hammer the rate limits, run prompts designed to burn tokens, or chain free trials. Use it like the product it is.",
  },
  {
    id: "responsibility",
    title: "Responsibility for Users & Affiliates",
    legal: [
      "Customer is responsible for the actions of any user accessing the Service through Customer’s account, including employees, contractors, and any end users to whom Customer makes the Service available (for example, via the embeddable widget).",
      "Customer must ensure that its users have agreed to terms at least as protective as these (the Terms of Service, this AUP, and the Privacy Policy) before granting them access.",
    ],
    plain:
      "Anything done under your account is your responsibility, including by your end users if you embed Atlas in your own product.",
  },
  {
    id: "enforcement",
    title: "Enforcement",
    legal: [
      "If Atlas reasonably believes Customer has violated this AUP, Atlas may, in proportion to the violation: (a) issue a written warning and request remediation within a stated period; (b) restrict the affected feature or rate-limit the affected account; (c) suspend the account, in whole or in part, with notice where reasonably possible; (d) terminate the Agreement for cause under the Terms.",
      "For violations that materially threaten the security or availability of the Service for other customers, or that involve illegal content, Atlas may suspend access immediately and without prior notice, and will provide notice as soon as practicable.",
      "Suspension or termination for AUP violation is not subject to the SLA credit obligations at useatlas.dev/sla.",
    ],
    plain:
      "Minor issues: warning + chance to fix. Serious issues (security, illegal content): immediate suspension. Repeat or material violations: termination for cause. SLA credits don’t apply when we suspend you for AUP violations.",
  },
  {
    id: "changes",
    title: "Changes",
    legal: [
      "Atlas may update this AUP. Material changes will be announced by email to account admins at least 30 days before taking effect, with the prior version archived and linked from this page.",
    ],
    plain:
      "Material changes are announced to account admins by email at least 30 days before they take effect.",
  },
];

export default function AupPage() {
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
      <Nav currentPage="/aup" />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        {/* Hero */}
        <section className="mx-auto max-w-4xl px-6 pt-16 pb-10 text-center md:pt-24 md:pb-14">
          <p className="animate-fade-in-up delay-100 mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
            // legal · aup
          </p>
          <h1 className="animate-fade-in-up delay-200 text-3xl font-semibold tracking-tight text-zinc-100 md:text-5xl">
            Acceptable Use Policy.
          </h1>
          <p className="animate-fade-in-up delay-300 mx-auto mt-4 max-w-xl text-lg text-zinc-400">
            What you can&rsquo;t do with Atlas Cloud. Specific, enforceable, and
            short enough to read in one sitting.
          </p>
          <div className="animate-fade-in-up delay-400 mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 font-mono text-[11px] tracking-wider text-zinc-400 uppercase">
            <span>effective 2026-04-26</span>
            <span aria-hidden="true">·</span>
            <span>v1.0</span>
            <span aria-hidden="true">·</span>
            <span>questions: legal@useatlas.dev</span>
          </div>
        </section>

        {/* Four prohibited categories */}
        <section
          aria-labelledby="four-prohibitions-heading"
          className="mx-auto max-w-5xl px-6 pt-6 pb-4 md:pt-8"
        >
          <p
            id="four-prohibitions-heading"
            className="mb-3 font-mono text-xs tracking-widest text-brand/80 uppercase"
          >
            // four things to avoid
          </p>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PROHIBITIONS.map((p) => (
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
            Questions or reports?
          </h2>
          <p className="mx-auto mb-6 max-w-xl text-zinc-400">
            Email security for suspected violations or coordinated testing
            requests, or legal for clarifications and negotiated terms on
            enterprise contracts.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="mailto:security@useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-white"
            >
              Email security
            </a>
            <a
              href="mailto:legal@useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100"
            >
              Email legal
            </a>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
