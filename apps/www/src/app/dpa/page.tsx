import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { Nav } from "../../components/nav";
import { TopGlow } from "../../components/shared";

export const metadata: Metadata = {
  title: "Data Processing Agreement — Atlas",
  description:
    "Atlas Data Processing Agreement (DPA) — data processing terms, security measures, subprocessors, and breach notification procedures.",
  openGraph: {
    title: "Data Processing Agreement — Atlas",
    description:
      "Standard DPA for Atlas Cloud covering data processing, security, subprocessors, and GDPR compliance.",
    url: "https://www.useatlas.dev/dpa",
    siteName: "Atlas",
    type: "website",
  },
};

// ---------------------------------------------------------------------------
// Content sections
// ---------------------------------------------------------------------------

interface Section {
  id: string;
  title: string;
  content: React.ReactNode;
}

const LAST_UPDATED = "April 2, 2026";

const SECTIONS: Section[] = [
  {
    id: "overview",
    title: "1. Overview",
    content: (
      <>
        <p>
          This Data Processing Agreement (&quot;DPA&quot;) forms part of the{" "}
          <a
            href="/terms"
            className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
          >
            Terms of Service
          </a>{" "}
          between Atlas DevHQ (&quot;Processor&quot;) and you
          (&quot;Controller&quot;) for the processing of personal data through
          Atlas Cloud.
        </p>
        <p>
          This DPA applies when Atlas processes personal data on your behalf as
          part of providing Atlas Cloud services. For a signed copy of this DPA,
          contact{" "}
          <a
            href="mailto:sales@useatlas.dev"
            className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
          >
            sales@useatlas.dev
          </a>
          .
        </p>
      </>
    ),
  },
  {
    id: "definitions",
    title: "2. Definitions",
    content: (
      <ul>
        <li>
          <strong>&quot;Personal Data&quot;</strong> means any information
          relating to an identified or identifiable natural person as defined in
          GDPR Article 4(1).
        </li>
        <li>
          <strong>&quot;Processing&quot;</strong> means any operation performed on
          personal data, including collection, storage, retrieval, use,
          disclosure, and deletion.
        </li>
        <li>
          <strong>&quot;Subprocessor&quot;</strong> means a third party engaged by
          Atlas to process personal data on behalf of the Controller.
        </li>
        <li>
          <strong>&quot;Data Subject&quot;</strong> means the individual to whom
          personal data relates.
        </li>
      </ul>
    ),
  },
  {
    id: "scope",
    title: "3. Scope of Processing",
    content: (
      <>
        <p>Atlas processes personal data in the following context:</p>
        <ul>
          <li>
            <strong>Subject matter.</strong> Providing text-to-SQL agent services
            via Atlas Cloud.
          </li>
          <li>
            <strong>Duration.</strong> For the term of your subscription plus
            the data retention period described in our{" "}
            <a
              href="/privacy"
              className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
            >
              Privacy Policy
            </a>
            .
          </li>
          <li>
            <strong>Nature and purpose.</strong> Executing database queries,
            storing conversation history, managing user accounts, processing
            payments, and maintaining audit logs.
          </li>
          <li>
            <strong>Categories of data.</strong> Account information (name,
            email), query text, query results, usage metrics, audit logs.
          </li>
          <li>
            <strong>Data subjects.</strong> Your employees, contractors, and
            authorized users who access Atlas Cloud, and any individuals whose
            personal data may appear in your datasource query results.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "obligations",
    title: "4. Processor Obligations",
    content: (
      <>
        <p>Atlas (as Processor) shall:</p>
        <ul>
          <li>
            Process personal data only on documented instructions from the
            Controller, unless required by law.
          </li>
          <li>
            Ensure that persons authorized to process personal data have
            committed to confidentiality.
          </li>
          <li>
            Implement appropriate technical and organizational security measures
            (see Section 6).
          </li>
          <li>
            Engage subprocessors only with prior notice and subject to equivalent
            data protection obligations.
          </li>
          <li>
            Assist the Controller in responding to data subject requests
            (access, rectification, erasure, portability).
          </li>
          <li>
            Delete or return all personal data upon termination of the service,
            at the Controller&apos;s choice.
          </li>
          <li>
            Make available to the Controller all information necessary to
            demonstrate compliance with this DPA.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "data-residency",
    title: "5. Data Residency",
    content: (
      <>
        <p>
          Atlas Cloud supports configurable data residency for Enterprise
          customers. You may select the region where your data is stored and
          processed:
        </p>
        <ul>
          <li>
            <strong>Region selection.</strong> Choose your preferred region
            during workspace setup or from the admin console. Available regions
            include US and EU.
          </li>
          <li>
            <strong>Data isolation.</strong> Query data is processed in the
            selected region and does not leave it. Internal routing ensures
            queries are directed to region-local infrastructure.
          </li>
          <li>
            <strong>Migration.</strong> Region migration is supported for
            Enterprise customers via our migration tooling, with planned
            downtime coordinated in advance.
          </li>
        </ul>
        <p>
          For standard (non-Enterprise) plans, data is processed in the US
          region by default.
        </p>
      </>
    ),
  },
  {
    id: "security-measures",
    title: "6. Security Measures",
    content: (
      <>
        <p>
          Atlas implements the following technical and organizational measures to
          protect personal data:
        </p>
        <p>
          <strong>Encryption.</strong>
        </p>
        <ul>
          <li>Data in transit: TLS 1.2+ for all connections.</li>
          <li>Data at rest: AES-256 encryption for stored data and backups.</li>
          <li>Database credentials: encrypted at rest, never exposed in logs or API responses.</li>
        </ul>
        <p>
          <strong>Access controls.</strong>
        </p>
        <ul>
          <li>Role-based access control (RBAC) with configurable custom roles.</li>
          <li>SSO and SCIM provisioning for Enterprise customers.</li>
          <li>IP allowlisting for workspace access restriction.</li>
          <li>Multi-factor authentication support.</li>
        </ul>
        <p>
          <strong>Application security.</strong>
        </p>
        <ul>
          <li>
            4-layer SQL validation pipeline preventing injection and unauthorized
            data access.
          </li>
          <li>Read-only database connections enforced at both application and connection level.</li>
          <li>Sandboxed code execution for explore operations.</li>
          <li>PII detection to flag sensitive data in query results.</li>
          <li>Table whitelisting ensuring only approved datasource tables are queryable.</li>
        </ul>
        <p>
          <strong>Infrastructure security.</strong>
        </p>
        <ul>
          <li>Automated backups with configurable retention.</li>
          <li>Network isolation between tenant workspaces.</li>
          <li>Comprehensive audit logging of all administrative and data access events.</li>
          <li>Incident monitoring via OpenStatus with public status page.</li>
        </ul>
      </>
    ),
  },
  {
    id: "subprocessors",
    title: "7. Subprocessors",
    content: (
      <>
        <p>
          Atlas uses the following subprocessors. We will notify you at least 30
          days before adding or replacing a subprocessor.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800/60">
                <th className="py-2 pr-6 text-left font-medium text-zinc-300">
                  Provider
                </th>
                <th className="py-2 pr-6 text-left font-medium text-zinc-300">
                  Purpose
                </th>
                <th className="py-2 text-left font-medium text-zinc-300">
                  Location
                </th>
              </tr>
            </thead>
            <tbody className="text-zinc-400">
              <tr className="border-b border-zinc-800/40">
                <td className="py-2 pr-6">Railway</td>
                <td className="py-2 pr-6">Infrastructure hosting</td>
                <td className="py-2">US / EU</td>
              </tr>
              <tr className="border-b border-zinc-800/40">
                <td className="py-2 pr-6">Stripe</td>
                <td className="py-2 pr-6">Payment processing</td>
                <td className="py-2">US</td>
              </tr>
              <tr className="border-b border-zinc-800/40">
                <td className="py-2 pr-6">OpenStatus</td>
                <td className="py-2 pr-6">Uptime monitoring</td>
                <td className="py-2">EU</td>
              </tr>
              <tr>
                <td className="py-2 pr-6">Anthropic</td>
                <td className="py-2 pr-6">Default LLM provider</td>
                <td className="py-2">US</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          You may object to a new subprocessor within 30 days of notification. If
          we cannot reasonably accommodate your objection, you may terminate the
          affected services.
        </p>
      </>
    ),
  },
  {
    id: "breach-notification",
    title: "8. Breach Notification",
    content: (
      <>
        <p>
          In the event of a personal data breach, Atlas will:
        </p>
        <ul>
          <li>
            Notify the Controller without undue delay and in any event within 72
            hours of becoming aware of the breach.
          </li>
          <li>
            Provide sufficient detail for the Controller to meet its own
            notification obligations, including: the nature of the breach,
            categories and approximate number of data subjects affected,
            likely consequences, and measures taken or proposed to mitigate the
            breach.
          </li>
          <li>
            Cooperate with the Controller in investigating and remediating the
            breach.
          </li>
          <li>
            Document all breaches, including facts, effects, and remedial
            actions taken, regardless of whether notification is required.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "data-subject-requests",
    title: "9. Data Subject Requests",
    content: (
      <>
        <p>
          Atlas will assist the Controller in responding to data subject requests
          exercising their rights under GDPR (access, rectification, erasure,
          restriction, portability, objection).
        </p>
        <p>
          If Atlas receives a request directly from a data subject, we will
          promptly notify the Controller and will not respond to the request
          without the Controller&apos;s instructions, unless legally required.
        </p>
      </>
    ),
  },
  {
    id: "audits",
    title: "10. Audits",
    content: (
      <>
        <p>
          Atlas will make available to the Controller all information necessary
          to demonstrate compliance with this DPA and allow for audits,
          including inspections, conducted by the Controller or an auditor
          mandated by the Controller.
        </p>
        <p>
          Audit requests should be directed to{" "}
          <a
            href="mailto:security@useatlas.dev"
            className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
          >
            security@useatlas.dev
          </a>{" "}
          with reasonable advance notice.
        </p>
      </>
    ),
  },
  {
    id: "international-transfers",
    title: "11. International Transfers",
    content: (
      <>
        <p>
          Where personal data is transferred outside the EEA, Atlas ensures
          appropriate safeguards are in place, including:
        </p>
        <ul>
          <li>
            Standard Contractual Clauses (SCCs) as approved by the European
            Commission.
          </li>
          <li>
            Data residency controls that keep data within the selected region
            (Enterprise).
          </li>
          <li>
            Transfer impact assessments for each subprocessor.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "termination",
    title: "12. Termination",
    content: (
      <>
        <p>
          Upon termination of the service agreement, Atlas will, at the
          Controller&apos;s choice:
        </p>
        <ul>
          <li>
            Return all personal data in a structured, machine-readable format
            (data export via admin console or API).
          </li>
          <li>
            Delete all personal data within 30 days, unless retention is
            required by law.
          </li>
        </ul>
        <p>
          Atlas will certify deletion upon the Controller&apos;s request.
        </p>
      </>
    ),
  },
  {
    id: "contact",
    title: "13. Contact",
    content: (
      <>
        <p>
          For a signed copy of this DPA or questions about data processing,
          contact{" "}
          <a
            href="mailto:sales@useatlas.dev"
            className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
          >
            sales@useatlas.dev
          </a>
          .
        </p>
        <p>
          For security inquiries, contact{" "}
          <a
            href="mailto:security@useatlas.dev"
            className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
          >
            security@useatlas.dev
          </a>
          .
        </p>
      </>
    ),
  },
];

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function LegalSection({ section }: { section: Section }) {
  return (
    <section id={section.id} className="scroll-mt-20">
      <h2 className="mb-4 font-mono text-base font-semibold tracking-tight text-zinc-100">
        {section.title}
      </h2>
      <div className="legal-prose space-y-3 text-sm leading-relaxed text-zinc-400">
        {section.content}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DpaPage() {
  return (
    <div className="relative min-h-screen">
      <TopGlow />
      <Nav />

      <article className="mx-auto max-w-3xl px-6 pt-8 pb-20 md:pt-12">
        <header className="mb-12">
          <p className="mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
            Legal
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
            Data Processing Agreement
          </h1>
          <p className="mt-3 text-sm text-zinc-500">
            Last updated: {LAST_UPDATED}
          </p>
          <div className="mt-4 rounded-lg border border-brand/20 bg-brand/5 px-4 py-3 text-sm text-zinc-400">
            For a signed copy of this DPA, contact{" "}
            <a
              href="mailto:sales@useatlas.dev"
              className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
            >
              sales@useatlas.dev
            </a>
            .
          </div>
        </header>

        <div className="space-y-10">
          {SECTIONS.map((section) => (
            <LegalSection key={section.id} section={section} />
          ))}
        </div>
      </article>

      <Footer />
    </div>
  );
}
