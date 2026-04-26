import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { LegalSection, LegalTOC, type LegalSectionData } from "../../components/legal";
import { Nav } from "../../components/nav";
import { TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";

export const metadata: Metadata = {
  title: "Terms of Service — Atlas",
  description:
    "The agreement between Atlas DevHQ and the people who use Atlas Cloud. 13 sections, dual-column legal / plain-english layout so the deal is readable.",
  openGraph: {
    title: "Terms of Service — Atlas",
    description:
      "Atlas Cloud terms of service: account terms, fees, customer data, IP, warranty, liability, indemnification, termination, governing law.",
    url: "https://www.useatlas.dev/terms",
    siteName: "Atlas",
    type: "website",
  },
};

const SECTIONS: LegalSectionData[] = [
  {
    id: "agreement",
    title: "The Agreement",
    legal: [
      'These Terms of Service ("Terms") are entered into between Atlas DevHQ ("Atlas", "we") and the entity or individual agreeing to them ("Customer", "you"). By creating an account, signing an order form, or using the Service, you accept these Terms.',
      "If you are accepting on behalf of a company, you represent that you have authority to bind that company. “You” then refers to that company.",
      "These Terms govern Atlas Cloud at app.useatlas.dev. The open-source Atlas distribution is licensed separately under AGPL-3.0 and is not subject to these Terms; commercial features in the /ee directory are licensed under the separate Atlas Commercial License.",
    ],
    plain:
      "These rules apply when you use Atlas Cloud. The open-source distribution is AGPL-3.0 and isn’t covered here; the commercial /ee features have their own license.",
  },
  {
    id: "service",
    title: "The Service",
    legal: [
      "Atlas provides a hosted text-to-SQL platform. Customer authenticates against its own data warehouse and identity provider; Atlas executes queries on Customer’s behalf in read-only mode (or write mode where Customer has explicitly granted such permission).",
      "Atlas may modify, add, or remove features at any time, but will not materially reduce the functionality of any feature included in Customer’s plan during the current paid term without 30 days’ notice.",
      'Beta and "Labs" features are provided as-is, may be removed at any time, and are excluded from the SLA.',
    ],
    plain:
      "We provide the hosted Atlas service. Improvements ship continuously, but we won’t materially reduce features in your plan during the paid term without 30 days’ notice.",
  },
  {
    id: "accounts",
    title: "Accounts & Acceptable Use",
    legal: [
      "Customer is responsible for maintaining the confidentiality of credentials and for all activity that occurs under its account. Customer must notify Atlas promptly of any unauthorized access. Account holders must be 18 years or older.",
      "Customer agrees not to: (a) use the Service to violate any law or third-party right; (b) attempt to reverse-engineer, decompile, or scrape the Service except as permitted by applicable law; (c) use the Service to develop a competing hosted product using the /ee commercial features; (d) probe, scan, or test the vulnerability of the Service without prior written consent; (e) submit data containing malware, exploits, or content prohibited by the Acceptable Use Policy at useatlas.dev/aup; (f) exceed published rate limits or otherwise abuse the Service in a way that degrades performance for other customers.",
      "Atlas may suspend access without notice for activity that materially threatens the security or availability of the Service for other customers. Where suspension is appropriate, Atlas will use commercially reasonable efforts to provide notice.",
    ],
    plain:
      "Use Atlas lawfully and as documented. Don’t probe our security without permission, don’t build a competing hosted product on the commercial /ee features, and don’t submit malicious content.",
  },
  {
    id: "fees",
    title: "Fees & Payment",
    legal: [
      "Customer agrees to pay all fees stated in the order form or on the pricing page in effect at the time of purchase. Fees are exclusive of taxes; Customer is responsible for sales, use, VAT, and similar taxes. Atlas Cloud paid plans include a 14-day free trial; trial accounts are provided without service-level commitment, support obligation, or liability — see Sections 8 and 9.",
      "Subscriptions auto-renew for the same term unless either party gives written notice of non-renewal at least 30 days before the renewal date. Atlas may increase prices at renewal with 30 days’ written notice. Bring-your-own-token (BYOK) usage is billed by the LLM provider directly; Atlas charges only for infrastructure under BYOK.",
      "Invoices are due within 30 days. Past-due amounts accrue interest at 1.5%/month or the maximum allowed by law. Atlas may suspend the Service for accounts more than 60 days past due. Refunds are not provided for partial billing periods; cancellation retains access through the end of the current period.",
    ],
    plain:
      "Pay invoices within 30 days. Subscriptions renew automatically; give 30 days’ notice to cancel. BYOK pays the LLM provider directly. No partial-period refunds.",
  },
  {
    id: "data",
    title: "Customer Data",
    legal: [
      "As between the parties, Customer owns Customer Data. Customer grants Atlas a limited license to process Customer Data solely to provide the Service.",
      "Atlas does not use Customer Data to train AI models. Atlas does not sell Customer Data. Atlas does not access Customer’s data warehouse contents except to execute queries that Customer’s authorized users explicitly issue. Query text is forwarded to the configured LLM provider (Anthropic, OpenAI, etc.) for processing under that provider’s terms.",
      "Atlas implements technical and organizational measures consistent with industry standards: encryption in transit (TLS 1.2+) and at rest (AES-256), least-privilege access, logged admin operations, configurable PII detection on result sets, and Business-plan data residency. Further detail is in the Data Processing Addendum at useatlas.dev/dpa.",
    ],
    plain:
      "You retain ownership of your data. We do not train models on it, sell it, or access your warehouse beyond executing queries your users explicitly issue. Encrypted in transit and at rest.",
  },
  {
    id: "ip",
    title: "Intellectual Property",
    legal: [
      "Atlas owns all rights in the Service, including the Atlas software, models, semantic-layer compiler, and documentation. Subject to these Terms, Atlas grants Customer a non-exclusive, non-transferable license to access and use the Service during the term. The open-source Atlas distribution is AGPL-3.0; commercial features in /ee are licensed under the separate Atlas Commercial License.",
      "Feedback that Customer provides about the Service is given without restriction; Atlas may use it without obligation.",
      "Trademarks of Atlas may not be used without prior written consent except to factually describe the use of the Service.",
    ],
    plain:
      "We own the Atlas software and grant you a license to use it. Open-source code is AGPL-3.0; commercial features have a separate license. Feedback you share is unrestricted on our side.",
  },
  {
    id: "confidentiality",
    title: "Confidentiality",
    legal: [
      "Each party will protect the other’s Confidential Information using the same degree of care it uses for its own (no less than reasonable care), and will not disclose it except to its employees, contractors, and advisors who need to know and are bound by confidentiality obligations.",
      "Confidential Information does not include information that is publicly available, independently developed without reference to the other party’s information, or rightfully obtained from a third party without confidentiality obligations.",
    ],
    plain:
      "Each side protects the other’s confidential information with the same care as its own.",
  },
  {
    id: "warranty",
    title: "Warranties & Disclaimer",
    legal: [
      "Atlas warrants that the Service will materially perform as described in the documentation. Customer’s exclusive remedy and Atlas’s sole liability for breach of this warranty is, at Atlas’s option, to repair the Service or terminate the agreement and refund unused prepaid fees.",
      'EXCEPT AS EXPRESSLY STATED, THE SERVICE IS PROVIDED "AS IS" AND ATLAS DISCLAIMS ALL OTHER WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.',
      "AI-generated SQL is non-deterministic. Atlas’s 4-layer validation pipeline (empty check, regex guard, AST parse, table whitelist) reduces risk; it does not eliminate it. Customer remains responsible for reviewing query output and for the appropriateness of using AI-generated SQL in its environment.",
    ],
    plain:
      "We warrant the product works as documented. Beyond that, AI-generated SQL is non-deterministic — our validators reduce risk, but you remain responsible for reviewing query output before acting on it.",
  },
  {
    id: "liability",
    title: "Limitation of Liability",
    legal: [
      "TO THE FULLEST EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR EXEMPLARY DAMAGES, OR FOR LOST PROFITS, REVENUE, OR DATA, EVEN IF ADVISED OF THE POSSIBILITY.",
      "EACH PARTY’S TOTAL AGGREGATE LIABILITY UNDER THESE TERMS WILL NOT EXCEED THE FEES PAID BY CUSTOMER TO ATLAS IN THE TWELVE MONTHS PRECEDING THE CLAIM. FOR FREE TRIAL ACCOUNTS, ATLAS’S TOTAL AGGREGATE LIABILITY IS ZERO DOLLARS ($0).",
      "These limitations do not apply to: (a) breach of confidentiality; (b) infringement of the other party’s intellectual-property rights; (c) gross negligence, fraud, or willful misconduct; (d) Customer’s payment obligations.",
    ],
    plain:
      "Liability is capped at fees paid in the prior 12 months (or $0 for free trials). Carve-outs for confidentiality breach, IP infringement, gross negligence, fraud, and willful misconduct.",
  },
  {
    id: "indemnity",
    title: "Indemnification",
    legal: [
      "Atlas will defend Customer against any third-party claim that the Service, when used in accordance with these Terms, infringes a U.S. patent, copyright, or trade secret, and will pay damages awarded by a court or agreed in settlement. This indemnification does not apply to claims arising from Customer Data, Customer modifications to the self-hosted distribution, combination with non-Atlas products, or free-trial usage.",
      "Customer will defend Atlas against claims arising from Customer Data, Customer’s use of the Service in violation of law, or Customer’s breach of these Terms.",
      "The indemnifying party’s obligations are conditional on the indemnified party giving prompt notice, sole control of the defense, and reasonable cooperation.",
    ],
    plain:
      "We defend you against IP claims arising from the Service. You defend us against claims arising from your data or your use of the Service in violation of law.",
  },
  {
    id: "term",
    title: "Term & Termination",
    legal: [
      "These Terms remain in effect while Customer has an active subscription. Either party may terminate for material breach uncured 30 days after written notice. Customer may terminate for cause with 30 days’ written notice if Atlas misses its SLA targets in any three consecutive calendar months, or in any four months within a rolling twelve-month period (see useatlas.dev/sla), and receive a pro-rata refund of any prepaid fees for the remaining term.",
      "On termination, Atlas will, on request, make Customer Data available for export for 30 days, after which it will be deleted from production systems within 30 days and from backups within 90 days.",
      "Sections that by nature should survive termination (Confidentiality, IP, Warranty disclaimers, Liability limits, Indemnification, Governing Law) survive.",
    ],
    plain:
      "Either party may terminate with notice. On termination, we make your data available for export for 30 days, then delete from production within 30 days and from backups within 90.",
  },
  {
    id: "law",
    title: "Governing Law & Disputes",
    legal: [
      "These Terms are governed by the laws of the State of Delaware, USA, without regard to conflict-of-laws principles. The parties consent to exclusive jurisdiction in the state and federal courts located in Wilmington, Delaware for any dispute not subject to arbitration.",
      "Disputes that are subject to arbitration will be resolved by binding arbitration administered by the American Arbitration Association under its Commercial Arbitration Rules, by a single arbitrator in Wilmington, Delaware.",
      "Either party may seek injunctive relief in court for breach of confidentiality or IP rights. The parties agree to bring claims only in their individual capacity, and not as a plaintiff or class member in any purported class or representative proceeding.",
    ],
    plain:
      "Disputes are governed by Delaware law and resolved in Delaware (court or AAA arbitration). No class actions; injunctive relief is still available for confidentiality / IP breaches.",
  },
  {
    id: "misc",
    title: "Miscellaneous",
    legal: [
      "These Terms, plus any order forms and the Data Processing Addendum, form the entire agreement and supersede prior discussions. Amendments must be in writing and signed by both parties, except Atlas may update these Terms with 30 days’ notice; continued use after that constitutes acceptance.",
      "If any provision is unenforceable, the remainder remains in effect. Failure to enforce a right is not a waiver. Customer may not assign these Terms without consent; Atlas may assign in connection with a merger or sale of substantially all assets.",
      "Notices to Atlas must be sent to legal@useatlas.dev. Notices to Customer will be sent to the email address on the account.",
    ],
    plain:
      "Standard closing provisions: this is the entire agreement, amendments require writing, partial unenforceability doesn’t void the rest, and legal notices go to legal@useatlas.dev.",
  },
];

export default function TermsPage() {
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
      <Nav currentPage="/terms" />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        {/* Hero */}
        <section className="mx-auto max-w-4xl px-6 pt-16 pb-10 text-center md:pt-24 md:pb-14">
          <p className="animate-fade-in-up delay-100 mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
            // legal · terms
          </p>
          <h1 className="animate-fade-in-up delay-200 text-3xl font-semibold tracking-tight text-zinc-100 md:text-5xl">
            Terms of Service.
          </h1>
          <p className="animate-fade-in-up delay-300 mx-auto mt-4 max-w-xl text-lg text-zinc-400">
            The agreement between Atlas DevHQ and the people who use Atlas
            Cloud. Two columns: the contract on the left, plain English on the
            right.
          </p>
          <div className="animate-fade-in-up delay-400 mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 font-mono text-[11px] tracking-wider text-zinc-400 uppercase">
            <span>effective 2026-01-15</span>
            <span aria-hidden="true">·</span>
            <span>v4.1</span>
            <span aria-hidden="true">·</span>
            <span>last updated 2026-04-02</span>
          </div>
        </section>

        {/* Legal sections — TOC + dual-column body */}
        <section className="mx-auto max-w-7xl px-6 py-8 md:py-12">
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
            Questions about these terms?
          </h2>
          <p className="mx-auto mb-6 max-w-xl text-zinc-400">
            Reach out to legal for clarifications, or to sales for negotiated
            terms on enterprise contracts.
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

