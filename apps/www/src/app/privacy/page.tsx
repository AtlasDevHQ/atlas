import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { Nav } from "../../components/nav";
import { TopGlow } from "../../components/shared";

export const metadata: Metadata = {
  title: "Privacy Policy — Atlas",
  description:
    "Atlas Privacy Policy — what data we collect, how we use it, your rights under GDPR, and our subprocessors.",
  openGraph: {
    title: "Privacy Policy — Atlas",
    description:
      "How Atlas handles your data: collection, use, retention, GDPR rights, and subprocessors.",
    url: "https://www.useatlas.dev/privacy",
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
          This Privacy Policy explains how Atlas DevHQ (&quot;Atlas&quot;,
          &quot;we&quot;, &quot;us&quot;, &quot;our&quot;) collects, uses, and
          protects your information when you use Atlas Cloud at{" "}
          <a
            href="https://app.useatlas.dev"

          >
            app.useatlas.dev
          </a>
          .
        </p>
        <p>
          If you self-host Atlas, your data stays entirely on your
          infrastructure. This policy applies to Atlas Cloud only.
        </p>
      </>
    ),
  },
  {
    id: "data-we-collect",
    title: "2. Data We Collect",
    content: (
      <>
        <p>We collect the following categories of data:</p>
        <p>
          <strong>Account information.</strong> Name, email address, and
          organization details provided during signup. If you use SSO, we receive
          identity attributes from your identity provider.
        </p>
        <p>
          <strong>Query and conversation history.</strong> The natural-language
          questions you ask, the SQL queries Atlas generates, and the results
          returned. This data is stored in your workspace and is accessible to
          your team.
        </p>
        <p>
          <strong>Semantic layer configuration.</strong> Entity definitions, metrics,
          glossary terms, and query patterns you configure to describe your
          datasources.
        </p>
        <p>
          <strong>Usage metrics.</strong> Query counts, token usage, feature
          usage, and performance data. These are used for billing, capacity
          planning, and service improvement.
        </p>
        <p>
          <strong>Audit logs.</strong> Records of administrative actions (user
          management, configuration changes, access events) for security and
          compliance.
        </p>
        <p>
          <strong>Technical data.</strong> IP addresses, browser type, and device
          information collected automatically for security and debugging.
        </p>
      </>
    ),
  },
  {
    id: "how-we-use-data",
    title: "3. How We Use Your Data",
    content: (
      <>
        <ul>
          <li>
            <strong>Service operation.</strong> Processing your queries, managing
            your workspace, and providing the Atlas agent experience.
          </li>
          <li>
            <strong>Billing.</strong> Tracking usage against your plan limits and
            processing payments through Stripe.
          </li>
          <li>
            <strong>Security.</strong> Detecting abuse, enforcing rate limits, and
            maintaining audit trails.
          </li>
          <li>
            <strong>Service improvement.</strong> Aggregate, anonymized usage
            patterns to improve Atlas. We do not use your queries, results, or
            datasource content to train AI models.
          </li>
          <li>
            <strong>Communication.</strong> Account notifications, security
            alerts, and product updates. You can unsubscribe from non-essential
            emails at any time.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "llm-providers",
    title: "4. LLM Providers",
    content: (
      <>
        <p>
          Atlas sends your natural-language questions, relevant semantic
          context, and query results to the configured LLM provider (Anthropic,
          OpenAI, or another provider you select) so the agent can generate SQL,
          interpret results, and respond. Result data is not stored by Atlas
          beyond what is retained in your conversation history.
        </p>
        <p>
          Each LLM provider has its own data handling policies. When using BYOT
          (bring your own token), your queries are processed under your direct
          agreement with the LLM provider.
        </p>
      </>
    ),
  },
  {
    id: "data-retention",
    title: "5. Data Retention and Deletion",
    content: (
      <>
        <ul>
          <li>
            <strong>Conversation history.</strong> Retained for the duration of
            your subscription. Workspace administrators can configure retention
            periods.
          </li>
          <li>
            <strong>Audit logs.</strong> Retained according to your plan&apos;s
            audit retention policy (configurable for Enterprise).
          </li>
          <li>
            <strong>Account data.</strong> Retained while your account is active.
            After cancellation, data is available read-only for 30 days, then
            permanently deleted.
          </li>
          <li>
            <strong>Backups.</strong> Encrypted backups are retained for disaster
            recovery and are purged on the same schedule as primary data.
          </li>
        </ul>
        <p>
          You can request immediate deletion of your data at any time by
          contacting{" "}
          <a
            href="mailto:privacy@useatlas.dev"

          >
            privacy@useatlas.dev
          </a>
          .
        </p>
      </>
    ),
  },
  {
    id: "subprocessors",
    title: "6. Subprocessors",
    content: (
      <>
        <p>We use the following subprocessors to operate Atlas Cloud:</p>
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
                <td className="py-2">US / EU (configurable)</td>
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
          Enterprise customers with data residency requirements can choose their
          deployment region. We will notify you of changes to our subprocessor
          list at least 30 days in advance.
        </p>
      </>
    ),
  },
  {
    id: "gdpr-rights",
    title: "7. Your Rights (GDPR)",
    content: (
      <>
        <p>
          If you are located in the European Economic Area (EEA), you have the
          following rights under the General Data Protection Regulation:
        </p>
        <ul>
          <li>
            <strong>Access.</strong> Request a copy of the personal data we hold
            about you.
          </li>
          <li>
            <strong>Rectification.</strong> Request correction of inaccurate
            personal data.
          </li>
          <li>
            <strong>Erasure.</strong> Request deletion of your personal data
            (&quot;right to be forgotten&quot;).
          </li>
          <li>
            <strong>Portability.</strong> Request your data in a structured,
            machine-readable format.
          </li>
          <li>
            <strong>Restriction.</strong> Request that we limit the processing
            of your data.
          </li>
          <li>
            <strong>Objection.</strong> Object to processing based on legitimate
            interests.
          </li>
        </ul>
        <p>
          To exercise these rights, contact{" "}
          <a
            href="mailto:privacy@useatlas.dev"

          >
            privacy@useatlas.dev
          </a>
          . We will respond within 30 days. If you are unsatisfied with our
          response, you may lodge a complaint with your local data protection
          authority.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "8. Cookies",
    content: (
      <>
        <p>
          Atlas Cloud uses only essential cookies required for the service to
          function:
        </p>
        <ul>
          <li>
            <strong>Session cookies.</strong> Used to maintain your authenticated
            session. These expire when you log out or after a period of
            inactivity.
          </li>
          <li>
            <strong>Preference cookies.</strong> Used to remember your workspace
            settings (theme, layout).
          </li>
        </ul>
        <p>
          We do not use third-party tracking cookies, advertising cookies, or
          analytics cookies. We do not participate in cross-site tracking or
          behavioral advertising.
        </p>
      </>
    ),
  },
  {
    id: "security",
    title: "9. Security",
    content: (
      <>
        <p>
          We implement industry-standard security measures to protect your data:
        </p>
        <ul>
          <li>Encryption in transit (TLS 1.2+) and at rest (AES-256).</li>
          <li>
            Role-based access control (RBAC) with configurable custom roles for
            Enterprise.
          </li>
          <li>
            SQL validation through a 4-layer pipeline to prevent injection and
            unauthorized data access.
          </li>
          <li>
            IP allowlisting and SSO/SCIM integration for Enterprise customers.
          </li>
          <li>Audit logging of all administrative and data access events.</li>
          <li>
            PII detection to flag sensitive data in query results.
          </li>
          <li>
            Sandboxed code execution for explore operations.
          </li>
        </ul>
        <p>
          For details on our security practices, see our{" "}
          <a
            href="/dpa"

          >
            Data Processing Agreement
          </a>
          .
        </p>
      </>
    ),
  },
  {
    id: "children",
    title: "10. Children's Privacy",
    content: (
      <p>
        Atlas Cloud is not intended for use by individuals under 18 years of age.
        We do not knowingly collect personal data from children. If you believe
        a child has provided us with personal data, please contact us and we will
        delete it.
      </p>
    ),
  },
  {
    id: "changes",
    title: "11. Changes to This Policy",
    content: (
      <p>
        We may update this Privacy Policy from time to time. Material changes
        will be communicated via email or an in-app notice at least 30 days
        before they take effect. The &quot;Last updated&quot; date at the top of
        this page reflects the most recent revision.
      </p>
    ),
  },
  {
    id: "contact",
    title: "12. Contact",
    content: (
      <>
        <p>
          For privacy-related questions or requests, contact us at{" "}
          <a
            href="mailto:privacy@useatlas.dev"

          >
            privacy@useatlas.dev
          </a>
          .
        </p>
        <p>
          For general inquiries, contact{" "}
          <a
            href="mailto:support@useatlas.dev"

          >
            support@useatlas.dev
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

export default function PrivacyPage() {
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
            Privacy Policy
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
