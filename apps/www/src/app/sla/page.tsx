import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { Nav } from "../../components/nav";
import { ArrowIcon, TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";

export const metadata: Metadata = {
  title: "SLA — Atlas",
  description:
    "Atlas Cloud Service Level Agreement: 99.9% uptime target on Business, automatic service credits, support response times, and a worked example of how credits are calculated.",
  openGraph: {
    title: "SLA — Atlas",
    description:
      "Atlas Cloud Service Level Agreement: uptime targets, credits ladder, support response times, and incident postmortem policy.",
    url: "https://www.useatlas.dev/sla",
    siteName: "Atlas",
    type: "website",
  },
};

const STATUS_PAGE_URL = "https://atlas.openstatus.dev";

interface UptimeCard {
  tier: string;
  kind: string;
  uptime: string;
  uptimeNote: string;
  credits: { threshold: string; credit: string }[];
  recommended?: boolean;
}

const UPTIME_CARDS: UptimeCard[] = [
  {
    tier: "Business",
    kind: "atlas cloud",
    uptime: "99.9%",
    uptimeNote: "≈ 43 min/month allowance",
    credits: [
      { threshold: "< 99.9%", credit: "10% credit" },
      { threshold: "< 99.0%", credit: "25% credit" },
      { threshold: "< 95.0%", credit: "50% credit" },
    ],
    recommended: true,
  },
  {
    tier: "Custom contract",
    kind: "enterprise",
    uptime: "up to 99.99%",
    uptimeNote: "negotiated in order form",
    credits: [{ threshold: "all thresholds", credit: "negotiated" }],
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
    id: "definitions",
    title: "Definitions",
    legal: [
      '"Service" means the Atlas Cloud product accessed via app.useatlas.dev, including the query API, semantic-layer service, and dashboard. The Service does not include the open-source distribution, customer-hosted deployments, or third-party data warehouses connected by Customer.',
      '"Downtime" means any minute during which the Service returns a 5xx response or fails to respond within 30 seconds for >50% of requests originating from Customer’s account, as measured by Atlas’s external monitoring (OpenStatus probes plus internal regional health checks).',
      '"Monthly Uptime Percentage" is calculated as (Total Minutes − Downtime Minutes) / Total Minutes for a calendar month, rounded to two decimal places.',
      '"Service Credit" means the percentage of monthly subscription fees applied to Customer’s next invoice when an Uptime Target is missed.',
    ],
    plain:
      "If Atlas Cloud returns errors or times out, that counts as downtime. If we miss our promise for the month, you receive a credit on the next invoice — automatically.",
  },
  {
    id: "targets",
    title: "Uptime Targets & Credits",
    legal: [
      "Atlas commits to a 99.9% Monthly Uptime Percentage on the Business plan (≈ 43 minutes/month allowance). Custom enterprise contracts may negotiate higher targets — up to 99.99% (≈ 4 minutes/month) — in an order form.",
      "If a target is missed, Service Credits are applied automatically to Customer’s next invoice. Credits do not require a claim to be filed, though Customer may request retroactive review for up to 30 days after the month in question.",
      "Service Credits are Customer’s sole and exclusive remedy for any unavailability or non-performance of the Service. The maximum credit in any single month is 50% of that month’s subscription fees.",
    ],
    plain:
      "We target 99.9% on Business. If we miss, you receive an automatic credit, capped at half of that month’s fees. Custom enterprise terms can negotiate up to 99.99%.",
  },
  {
    id: "latency",
    title: "Query Latency Targets",
    legal: [
      "Atlas targets the following 95th-percentile latencies for end-to-end query execution on Atlas Cloud:",
      "SQL generation: p95 < 5s — measured from prompt submission to generated SQL ready for execution. API response (non-query): p95 < 500ms — admin, auth, settings, and other non-agent endpoints.",
      "Query execution latency against Customer’s warehouse is excluded from these targets — performance is determined by the warehouse, not by Atlas. Atlas does not store warehouse contents; queries pass through in-memory only.",
    ],
    plain:
      "SQL generation aims for p95 under 5 seconds. Admin/API endpoints target p95 under 500ms. The time your warehouse takes to run the query is on your warehouse, not on us.",
  },
  {
    id: "exclusions",
    title: "Exclusions",
    legal: [
      "Downtime does not include unavailability caused by: (a) scheduled maintenance announced ≥7 days in advance via status.useatlas.dev; (b) Customer-caused issues, including misconfiguration, exceeding rate limits, or use of unsupported model endpoints; (c) failures of Customer’s data warehouse, identity provider, or model provider; (d) force majeure events; (e) suspension of the account for non-payment or violation of the Acceptable Use Policy.",
      "Maintenance windows are limited to 2 hours per month and are scheduled outside 09:00–18:00 in Customer’s primary business timezone where reasonably possible.",
    ],
    plain:
      "A few things don’t count as our downtime: announced maintenance windows, your warehouse or model API failing, force majeure, and accounts suspended for non-payment.",
  },
  {
    id: "support",
    title: "Support Response Times",
    legal: [
      "Atlas provides email support at support@useatlas.dev with the following first-response targets, measured 24×7 from the time a ticket is opened:",
      "Severity 1 (Service unavailable, no workaround): Business — 4 hours. Custom enterprise — 1 hour. Severity 2 (Major feature broken, workaround exists): Business — 8 business hours. Custom enterprise — 4 hours. Severity 3 (Minor issue, request for information): Business — 1 business day. Custom enterprise — 8 business hours.",
      "Custom enterprise customers receive a named Customer Success Manager and a dedicated Slack Connect channel. Sev-1 issues on custom contracts trigger immediate paging of the on-call engineer.",
    ],
    plain:
      "Email reaches a real engineer. Severity-1 issues on custom enterprise contracts page our on-call team immediately, day or night.",
  },
  {
    id: "status",
    title: "Status, Incidents & Postmortems",
    legal: [
      "Atlas maintains a public status page at status.useatlas.dev showing current Service health, ongoing incidents, and historical uptime by region.",
      "For any Severity 1 incident, Atlas will publish a written postmortem within 5 business days of resolution. Postmortems include timeline, root cause, remediation steps, and a list of preventive measures.",
      "Customers may subscribe to status updates via email, RSS, Slack, or webhook.",
    ],
    plain:
      "Our public status page shows current health and history. After any major incident we publish a written postmortem within 5 business days.",
  },
  {
    id: "data",
    title: "Data Durability",
    legal: [
      "Customer data stored in the Service (semantic-layer definitions, audit logs, user accounts) is replicated across at least three availability zones in the Customer’s selected region. Atlas targets a Recovery Point Objective (RPO) of 5 minutes and a Recovery Time Objective (RTO) of 1 hour for catastrophic failure scenarios.",
      "Atlas does not store the contents of Customer’s data warehouse. Query execution is read-only and pass-through; result sets are cached in-memory only for the duration of the user session.",
    ],
    plain:
      "Your configuration and audit logs are replicated across three availability zones with a 5-minute RPO. Your warehouse data is never stored on our side — queries pass through in-memory only.",
  },
  {
    id: "termination",
    title: "Termination for Chronic Breach",
    legal: [
      "If Atlas misses its Uptime Target in any three consecutive calendar months, or in any four months within a rolling twelve-month period, Customer may terminate the agreement for cause with 30 days’ written notice and receive a pro-rata refund of any prepaid fees for the remaining term.",
    ],
    plain:
      "If we repeatedly miss our targets, you may terminate for cause and receive a pro-rata refund of any prepaid fees.",
  },
];

export default function SLAPage() {
  return (
    <div className="relative min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-zinc-900 focus:px-3 focus:py-2 focus:font-mono focus:text-sm focus:text-zinc-100 focus:ring-2 focus:ring-brand"
      >
        Skip to content
      </a>

      <StickyNav />
      <TopGlow />
      <Nav currentPage="/sla" />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        {/* Hero */}
        <section className="mx-auto max-w-4xl px-6 pt-16 pb-10 text-center md:pt-24 md:pb-14">
          <p className="animate-fade-in-up delay-100 mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
            // legal · sla
          </p>
          <h1 className="animate-fade-in-up delay-200 text-3xl font-semibold tracking-tight text-zinc-100 md:text-5xl">
            Service Level Agreement.
          </h1>
          <p className="animate-fade-in-up delay-300 mx-auto mt-4 max-w-xl text-lg text-zinc-400">
            What we promise on Atlas Cloud — uptime targets, credits, response
            times, and what happens if we miss.
          </p>
          <div className="animate-fade-in-up delay-400 mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 font-mono text-[11px] tracking-wider text-zinc-400 uppercase">
            <span>effective 2026-01-15</span>
            <span aria-hidden="true">·</span>
            <span>v3.2</span>
            <span aria-hidden="true">·</span>
            <span>applies to: atlas cloud</span>
          </div>
          <div className="animate-fade-in-up delay-500 mt-6">
            <a
              href={STATUS_PAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100"
            >
              View live status
              <ArrowIcon />
            </a>
          </div>
        </section>

        {/* Worked example */}
        <section
          aria-labelledby="worked-example-heading"
          className="mx-auto max-w-5xl px-6 pt-8 pb-4 md:pt-10"
        >
          <p className="mb-3 font-mono text-xs tracking-widest text-brand/80 uppercase">
            // worked example
          </p>
          <div className="rounded-2xl border border-brand/30 bg-brand/4 p-6 md:p-8">
            <h2
              id="worked-example-heading"
              className="mb-6 text-base font-medium text-zinc-100 md:text-lg"
            >
              If a Business team hits 99.4% uptime in March on a $1,980/mo plan
              (20 seats × $99) …
            </h2>
            <ol className="grid items-center gap-5 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:gap-4">
              <WorkedExampleStep
                label="actual uptime"
                value="99.40%"
                note="≈ 268 min downtime"
              />
              <WorkedExampleArrow />
              <WorkedExampleStep
                label="credit tier hit"
                value="25%"
                note="uptime < 99.0%"
              />
              <WorkedExampleArrow />
              <WorkedExampleStep
                label="April invoice"
                value="−$495"
                valueClassName="text-brand"
                note="auto-applied · no claim filing"
              />
            </ol>
          </div>
        </section>

        {/* Uptime targets at a glance */}
        <section
          aria-labelledby="uptime-targets-heading"
          className="mx-auto max-w-5xl px-6 py-12 md:py-16"
        >
          <p className="mb-3 font-mono text-xs tracking-widest text-brand/80 uppercase">
            // uptime targets at a glance
          </p>
          <h2
            id="uptime-targets-heading"
            className="mb-6 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl"
          >
            Targets &amp; credits ladder.
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            {UPTIME_CARDS.map((card) => (
              <UptimeTargetCard key={card.tier} card={card} />
            ))}
          </div>
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
                <SLALegalSection key={section.id} section={section} index={i} />
              ))}
            </article>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="mx-auto max-w-4xl px-6 py-16 text-center md:py-24">
          <h2 className="mb-3 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
            Questions about coverage?
          </h2>
          <p className="mx-auto mb-6 max-w-xl text-zinc-400">
            For Business customers, SLA terms are included in your subscription.
            For custom enterprise terms — higher targets, named CSM, dedicated
            Slack — talk to sales.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="mailto:sales@useatlas.dev"
              className="group inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-white"
            >
              Talk to sales
              <ArrowIcon />
            </a>
            <a
              href="/pricing"
              className="group inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100"
            >
              View pricing
              <ArrowIcon />
            </a>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}

function WorkedExampleStep({
  label,
  value,
  valueClassName,
  note,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  note: string;
}) {
  return (
    <li className="flex flex-col">
      <p className="mb-1.5 font-mono text-[10.5px] tracking-widest text-zinc-400 uppercase">
        {label}
      </p>
      <p
        className={`mb-1 text-3xl leading-none font-semibold tracking-tight md:text-[30px] ${
          valueClassName ?? "text-zinc-100"
        }`}
      >
        {value}
      </p>
      <p className="font-mono text-[11px] tracking-wider text-zinc-400">{note}</p>
    </li>
  );
}

function WorkedExampleArrow() {
  return (
    <span
      aria-hidden="true"
      className="hidden text-xl text-zinc-400 md:inline-flex md:items-center md:justify-center"
    >
      →
    </span>
  );
}

function UptimeTargetCard({ card }: { card: UptimeCard }) {
  return (
    <div
      className={`rounded-2xl border p-6 md:p-7 ${
        card.recommended
          ? "border-brand/40 bg-zinc-900/55"
          : "border-zinc-800/60 bg-zinc-900/30"
      }`}
    >
      <p className="mb-2 font-mono text-[11px] tracking-wider text-zinc-400 uppercase">
        // {card.kind}
      </p>
      <p className="mb-3 text-lg font-semibold text-zinc-100">{card.tier}</p>
      <p className="text-[40px] leading-none font-semibold tracking-tight text-brand">
        {card.uptime}
      </p>
      <p className="mt-1.5 font-mono text-[11px] tracking-wider text-zinc-400">
        {card.uptimeNote}
      </p>
      <p className="mt-6 mb-2 font-mono text-[10.5px] tracking-widest text-zinc-400 uppercase">
        // service credits
      </p>
      <ul className="space-y-1.5">
        {card.credits.map((c) => (
          <li
            key={`${c.threshold}-${c.credit}`}
            className="flex items-baseline justify-between gap-3 font-mono text-[12.5px]"
          >
            <span className="text-zinc-400">{c.threshold}</span>
            <span className="text-zinc-200">{c.credit}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SLALegalSection({ section, index }: { section: LegalSection; index: number }) {
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
