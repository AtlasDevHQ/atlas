import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { Nav } from "../../components/nav";
import { TopGlow } from "../../components/shared";

export const metadata: Metadata = {
  title: "Terms of Service — Atlas",
  description:
    "Atlas Terms of Service — acceptable use, account terms, payment terms, data handling, and more.",
  openGraph: {
    title: "Terms of Service — Atlas",
    description:
      "Atlas Terms of Service for Atlas Cloud (app.useatlas.dev) and self-hosted deployments.",
    url: "https://useatlas.dev/terms",
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
          These Terms of Service (&quot;Terms&quot;) govern your use of Atlas, a
          text-to-SQL data analyst agent, operated by Atlas DevHQ
          (&quot;Atlas&quot;, &quot;we&quot;, &quot;us&quot;, &quot;our&quot;).
        </p>
        <p>
          Atlas is available in two modes:
        </p>
        <ul>
          <li>
            <strong>Self-hosted</strong> — free under the{" "}
            <a
              href="https://github.com/AtlasDevHQ/atlas/blob/main/LICENSE"
              className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
            >
              AGPL-3.0 license
            </a>
            . You deploy Atlas on your own infrastructure with full control over
            your data.
          </li>
          <li>
            <strong>Atlas Cloud</strong> — hosted at{" "}
            <a
              href="https://app.useatlas.dev"
              className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
            >
              app.useatlas.dev
            </a>
            . These Terms apply primarily to Atlas Cloud. Enterprise features are
            available under a separate{" "}
            <a
              href="https://github.com/AtlasDevHQ/atlas/blob/main/ee/LICENSE"
              className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
            >
              commercial license
            </a>
            .
          </li>
        </ul>
        <p>
          By creating an account or using Atlas Cloud, you agree to these Terms.
          If you do not agree, do not use the service.
        </p>
      </>
    ),
  },
  {
    id: "account-terms",
    title: "2. Account Terms",
    content: (
      <>
        <p>
          You must provide accurate information when creating an account. You are
          responsible for maintaining the security of your account credentials and
          for all activity under your account.
        </p>
        <ul>
          <li>You must be 18 years or older to use Atlas Cloud.</li>
          <li>
            One person or entity may not maintain more than one free trial at a
            time.
          </li>
          <li>
            You are responsible for all content and queries executed through your
            account.
          </li>
          <li>
            You must promptly notify us of any unauthorized access to your
            account.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "3. Acceptable Use",
    content: (
      <>
        <p>You agree not to use Atlas to:</p>
        <ul>
          <li>
            Violate any applicable laws or regulations.
          </li>
          <li>
            Attempt to gain unauthorized access to other users&apos; data or
            systems.
          </li>
          <li>
            Transmit malicious code, SQL injection attacks, or exploit
            vulnerabilities in the service.
          </li>
          <li>
            Reverse-engineer, decompile, or attempt to extract the source code of
            Atlas Cloud (the self-hosted version is open-source under AGPL-3.0).
          </li>
          <li>
            Use Atlas Cloud to build a competing hosted service using our{" "}
            <a
              href="https://github.com/AtlasDevHQ/atlas/blob/main/ee/LICENSE"
              className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
            >
              enterprise features
            </a>
            .
          </li>
          <li>
            Exceed published rate limits or otherwise abuse the service in a way
            that degrades performance for other users.
          </li>
        </ul>
        <p>
          We reserve the right to suspend or terminate accounts that violate
          these terms.
        </p>
      </>
    ),
  },
  {
    id: "payment-terms",
    title: "4. Payment Terms",
    content: (
      <>
        <p>
          Atlas Cloud offers Team and Enterprise plans billed through Stripe. The
          self-hosted version is free and always will be.
        </p>
        <ul>
          <li>
            <strong>Trial.</strong> The Team plan includes a 14-day free trial. No
            credit card is required to start.
          </li>
          <li>
            <strong>Billing cycle.</strong> Subscriptions are billed monthly or
            annually, at the beginning of each period.
          </li>
          <li>
            <strong>No overage charges.</strong> When you approach your plan
            limits, you&apos;ll receive warnings. If you hit a limit, queries
            pause until the next billing cycle or you upgrade.
          </li>
          <li>
            <strong>Refunds.</strong> We do not provide refunds for partial billing
            periods. You may cancel at any time and retain access through the end
            of your current billing period.
          </li>
          <li>
            <strong>Price changes.</strong> We will provide at least 30 days&apos;
            notice before any price increase takes effect.
          </li>
          <li>
            <strong>BYOT.</strong> Bring-your-own-token users pay their LLM
            provider directly. Atlas only charges for infrastructure in BYOT mode.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "data-handling",
    title: "5. Data Handling",
    content: (
      <>
        <p>
          Atlas connects to your analytics databases to execute read-only queries
          on your behalf. We take data handling seriously:
        </p>
        <ul>
          <li>
            <strong>Read-only access.</strong> Atlas enforces read-only database
            connections. All SQL is validated through a 4-layer security pipeline
            (empty check, regex guard, AST parse, table whitelist) before
            execution.
          </li>
          <li>
            <strong>Data residency.</strong> Enterprise customers can choose their
            data residency region. Query data is processed in the selected region
            and does not leave it.
          </li>
          <li>
            <strong>Query history.</strong> Conversation and query history is
            stored in Atlas Cloud&apos;s internal database for your access.
            Retention periods are configurable by workspace administrators.
          </li>
          <li>
            <strong>No training on your data.</strong> We do not use your queries,
            results, or datasource content to train AI models. Query text is sent
            to the configured LLM provider (Anthropic, OpenAI, etc.) for
            processing under their terms.
          </li>
          <li>
            <strong>Encryption.</strong> All data is encrypted in transit (TLS 1.2+)
            and at rest (AES-256).
          </li>
          <li>
            <strong>PII detection.</strong> Atlas includes configurable PII
            detection to flag sensitive data in query results.
          </li>
        </ul>
        <p>
          For full details, see our{" "}
          <a
            href="/privacy"
            className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
          >
            Privacy Policy
          </a>{" "}
          and{" "}
          <a
            href="/dpa"
            className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
          >
            Data Processing Agreement
          </a>
          .
        </p>
      </>
    ),
  },
  {
    id: "intellectual-property",
    title: "6. Intellectual Property",
    content: (
      <>
        <p>
          <strong>Your data.</strong> You retain all rights to your data, queries,
          and results. Atlas does not claim ownership of any content you create or
          access through the service.
        </p>
        <p>
          <strong>Atlas software.</strong> The core Atlas platform is licensed
          under AGPL-3.0. Enterprise features in the <code>/ee</code> directory
          are licensed under a separate commercial license. Atlas Cloud&apos;s
          hosted infrastructure and proprietary service components remain the
          property of Atlas DevHQ.
        </p>
        <p>
          <strong>Feedback.</strong> If you provide suggestions or feedback about
          Atlas, we may use it to improve the product without obligation to you.
        </p>
      </>
    ),
  },
  {
    id: "service-availability",
    title: "7. Service Availability",
    content: (
      <>
        <p>
          We strive to maintain high availability for Atlas Cloud. Current system
          status is available at{" "}
          <a
            href="/status"
            className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
          >
            useatlas.dev/status
          </a>
          .
        </p>
        <ul>
          <li>
            We do not guarantee 100% uptime. Planned maintenance will be
            communicated in advance.
          </li>
          <li>
            Enterprise customers may negotiate SLA terms with guaranteed uptime
            and response times.
          </li>
          <li>
            We are not liable for downtime caused by third-party services
            (database providers, LLM APIs, cloud infrastructure).
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "limitation-of-liability",
    title: "8. Limitation of Liability",
    content: (
      <>
        <p>
          To the maximum extent permitted by law, Atlas DevHQ shall not be liable
          for any indirect, incidental, special, consequential, or punitive
          damages, including but not limited to loss of data, profits, or
          business opportunities.
        </p>
        <p>
          Our total liability for any claim arising from these Terms or your use
          of Atlas Cloud shall not exceed the amount you paid us in the 12 months
          preceding the claim.
        </p>
        <p>
          Atlas executes read-only queries against your databases. While we
          enforce strict validation, you are responsible for ensuring your
          datasource credentials have appropriate permissions. Atlas is not
          responsible for the accuracy of AI-generated SQL or query results.
        </p>
      </>
    ),
  },
  {
    id: "termination",
    title: "9. Termination",
    content: (
      <>
        <p>
          <strong>By you.</strong> You may cancel your account at any time from the
          admin console. Upon cancellation, your access continues through the end
          of the current billing period. After that, your workspace becomes
          read-only for 30 days, then data is deleted.
        </p>
        <p>
          <strong>By us.</strong> We may suspend or terminate your account if you
          violate these Terms, fail to pay, or if required by law. We will
          provide reasonable notice when possible.
        </p>
        <p>
          <strong>Data export.</strong> You may export your data (conversations,
          audit logs, semantic layer configurations) at any time before account
          deletion.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "10. Changes to Terms",
    content: (
      <>
        <p>
          We may update these Terms from time to time. Material changes will be
          communicated via email or an in-app notice at least 30 days before they
          take effect. Continued use of Atlas Cloud after changes take effect
          constitutes acceptance.
        </p>
      </>
    ),
  },
  {
    id: "governing-law",
    title: "11. Governing Law",
    content: (
      <>
        <p>
          These Terms are governed by the laws of the State of Delaware, United
          States, without regard to conflict of law principles. Any disputes
          shall be resolved in the courts of Delaware.
        </p>
      </>
    ),
  },
  {
    id: "contact",
    title: "12. Contact",
    content: (
      <>
        <p>
          Questions about these Terms? Contact us at{" "}
          <a
            href="mailto:legal@useatlas.dev"
            className="text-brand/80 underline decoration-brand/30 underline-offset-2 hover:text-brand"
          >
            legal@useatlas.dev
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

export default function TermsPage() {
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
            Terms of Service
          </h1>
          <p className="mt-3 text-sm text-zinc-500">
            Last updated: {LAST_UPDATED}
          </p>
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
