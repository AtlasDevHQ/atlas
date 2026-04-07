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
    url: "https://www.useatlas.dev/terms",
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
  
            >
              app.useatlas.dev
            </a>
            . These Terms apply primarily to Atlas Cloud. Additional features are
            available under a separate{" "}
            <a
              href="https://github.com/AtlasDevHQ/atlas/blob/main/ee/LICENSE"
  
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
          Atlas Cloud offers Starter, Pro, and Business plans billed through Stripe.
          The self-hosted version is free and always will be.
        </p>
        <ul>
          <li>
            <strong>Trial.</strong> All paid plans include a 14-day free trial. No
            credit card is required to start. Free trial accounts are provided
            without any service level commitment, support obligation, or
            liability on our part — see Sections 8 and 9.
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
            <strong>Data residency.</strong> Business plan customers can choose their
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

          >
            Privacy Policy
          </a>{" "}
          and{" "}
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
          under AGPL-3.0. Additional features in the <code>/ee</code> directory
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

          >
            www.useatlas.dev/status
          </a>
          .
        </p>
        <ul>
          <li>
            We do not guarantee 100% uptime. Planned maintenance will be
            communicated in advance.
          </li>
          <li>
            Business plan customers receive SLA commitments with guaranteed
            uptime and response times.
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
    id: "disclaimer-of-warranties",
    title: "8. Disclaimer of Warranties",
    content: (
      <>
        <p>
          ATLAS CLOUD IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot;
          WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY,
          INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY,
          FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
        </p>
        <p>
          Without limiting the foregoing, Atlas does not warrant that: (a) the
          service will be uninterrupted or error-free; (b) AI-generated SQL
          queries or results will be accurate, complete, or suitable for any
          particular purpose; (c) any defects will be corrected; or (d) the
          service will meet your specific requirements.
        </p>
        <p>
          You are responsible for evaluating AI-generated queries before relying
          on results for business decisions.
        </p>
      </>
    ),
  },
  {
    id: "limitation-of-liability",
    title: "9. Limitation of Liability",
    content: (
      <>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, ATLAS DEVHQ SHALL NOT BE
          LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR
          PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF DATA, PROFITS,
          OR BUSINESS OPPORTUNITIES, ARISING OUT OF OR IN CONNECTION WITH THESE
          TERMS OR YOUR USE OF ATLAS CLOUD.
        </p>
        <p>
          <strong>Free and trial accounts.</strong> IF YOU ARE USING ATLAS CLOUD
          ON A FREE TRIAL OR OTHERWISE WITHOUT A PAID SUBSCRIPTION, THE SERVICE
          IS PROVIDED AT YOUR SOLE RISK. OUR TOTAL LIABILITY TO YOU IS ZERO
          DOLLARS ($0). YOU EXPRESSLY ACKNOWLEDGE THAT FREE AND TRIAL ACCESS
          CARRIES NO WARRANTY, NO SLA, NO SUPPORT OBLIGATION, AND NO LIABILITY
          OF ANY KIND ON THE PART OF ATLAS DEVHQ.
        </p>
        <p>
          <strong>Paid accounts.</strong> For active paid subscriptions, our
          total aggregate liability for any claim arising from these Terms or
          your use of Atlas Cloud shall not exceed the amount you actually paid
          us in the 12 months preceding the claim.
        </p>
        <p>
          Atlas executes read-only queries against your databases. While we
          enforce strict validation, you are responsible for ensuring your
          datasource credentials have appropriate permissions. You are solely
          responsible for the data you connect to Atlas and for verifying the
          accuracy of AI-generated queries and results before acting on them.
        </p>
      </>
    ),
  },
  {
    id: "indemnification",
    title: "10. Indemnification",
    content: (
      <>
        <p>
          <strong>By you.</strong> You agree to indemnify and hold harmless Atlas
          DevHQ from any claims, damages, losses, liabilities, and expenses
          (including reasonable attorney&apos;s fees) arising from: (a) your
          violation of these Terms; (b) your use of Atlas Cloud; (c) any data
          you submit or make accessible through Atlas Cloud; or (d) your
          violation of any third-party rights.
        </p>
        <p>
          <strong>By us (paid accounts only).</strong> For customers with an
          active paid subscription, Atlas DevHQ will indemnify you from
          third-party claims alleging that Atlas Cloud infringes the intellectual
          property rights of a third party, provided that: (a) you promptly
          notify us of the claim; (b) you give us sole control over the defense;
          and (c) you provide reasonable cooperation. This indemnification does
          not apply to claims arising from your data, your modifications to the
          self-hosted version, use in combination with non-Atlas products, or
          free or trial usage.
        </p>
      </>
    ),
  },
  {
    id: "termination",
    title: "11. Termination",
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
    title: "12. Changes to Terms",
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
    title: "13. Governing Law and Disputes",
    content: (
      <>
        <p>
          These Terms are governed by the laws of the State of Delaware, United
          States, without regard to conflict of law principles.
        </p>
        <p>
          Any dispute arising from these Terms or your use of Atlas Cloud shall
          be resolved through binding arbitration administered by the American
          Arbitration Association (AAA) under its Commercial Arbitration Rules.
          Arbitration shall be conducted by a single arbitrator in Wilmington,
          Delaware. The arbitrator&apos;s decision shall be final and binding.
        </p>
        <p>
          YOU AND ATLAS DEVHQ AGREE THAT EACH MAY BRING CLAIMS AGAINST THE
          OTHER ONLY IN YOUR OR ITS INDIVIDUAL CAPACITY, AND NOT AS A PLAINTIFF
          OR CLASS MEMBER IN ANY PURPORTED CLASS OR REPRESENTATIVE PROCEEDING.
        </p>
        <p>
          Either party may seek injunctive or equitable relief in any court of
          competent jurisdiction to protect its intellectual property rights.
        </p>
      </>
    ),
  },
  {
    id: "contact",
    title: "14. Contact",
    content: (
      <>
        <p>
          Questions about these Terms? Contact us at{" "}
          <a
            href="mailto:legal@useatlas.dev"

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
