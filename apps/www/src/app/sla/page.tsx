import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { Nav } from "../../components/nav";
import { ArrowIcon, CheckIcon, Divider, SectionLabel, TopGlow } from "../../components/shared";

export const metadata: Metadata = {
  title: "SLA — Atlas",
  description:
    "Atlas Cloud SLA commitments: uptime guarantees, query latency targets, and support response times by plan.",
  openGraph: {
    title: "SLA — Atlas",
    description:
      "Atlas Cloud SLA commitments: uptime guarantees, latency targets, and support tiers.",
    url: "https://useatlas.dev/sla",
    siteName: "Atlas",
    type: "website",
  },
};

// ---------------------------------------------------------------------------
// SLA data — structured for easy updates
// ---------------------------------------------------------------------------

interface UptimeTier {
  plan: string;
  target: string;
  measurement: string;
  credit: string;
}

const UPTIME_TIERS: UptimeTier[] = [
  {
    plan: "Team",
    target: "99.9%",
    measurement: "5-minute intervals, excluding scheduled maintenance",
    credit: "10x credit for downtime exceeding SLA",
  },
  {
    plan: "Enterprise",
    target: "99.95%",
    measurement: "5-minute intervals, excluding scheduled maintenance",
    credit: "10x credit for downtime exceeding SLA",
  },
];

interface LatencyTarget {
  metric: string;
  target: string;
  note?: string;
}

const LATENCY_TARGETS: LatencyTarget[] = [
  {
    metric: "SQL generation",
    target: "p95 < 5s",
    note: "End-to-end time from prompt to generated query",
  },
  {
    metric: "Query execution",
    target: "Depends on your database",
    note: "Excluded from SLA — performance is determined by your datasource",
  },
  {
    metric: "API response (non-query)",
    target: "p95 < 500ms",
    note: "Admin, auth, settings, and other non-agent endpoints",
  },
];

interface SupportTier {
  plan: string;
  critical: string;
  high: string;
  normal: string;
  channels: string;
}

const SUPPORT_TIERS: SupportTier[] = [
  {
    plan: "Self-Hosted",
    critical: "Community",
    high: "Community",
    normal: "Community",
    channels: "GitHub Discussions",
  },
  {
    plan: "Team",
    critical: "24h (business hours)",
    high: "24h (business hours)",
    normal: "24h (business hours)",
    channels: "Email",
  },
  {
    plan: "Enterprise",
    critical: "4h",
    high: "8h",
    normal: "24h",
    channels: "Dedicated Slack, email, phone",
  },
];

const STATUS_PAGE_URL = "https://atlas.openstatus.dev";

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function MetricCard({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-6 md:p-8">
      <p className="mb-1 font-mono text-xs tracking-widest text-brand/80 uppercase">
        {label}
      </p>
      <p className="text-2xl font-semibold tracking-tight text-zinc-100">
        {value}
      </p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SLAPage() {
  return (
    <div className="relative min-h-screen">
      <TopGlow />
      <Nav currentPage="/sla" />

      {/* Hero */}
      <section className="mx-auto max-w-4xl px-6 pt-16 pb-20 text-center md:pt-24 md:pb-28">
        <div className="animate-fade-in-up delay-100">
          <SectionLabel>Service Level Agreement</SectionLabel>
        </div>
        <h1 className="animate-fade-in-up delay-200 text-3xl font-semibold tracking-tight text-zinc-100 md:text-5xl">
          Our commitment to reliability
        </h1>
        <p className="animate-fade-in-up delay-300 mx-auto mt-4 max-w-xl text-lg text-zinc-400">
          Atlas Cloud is built for production workloads. These are the targets
          we hold ourselves to — and the credits we offer when we fall short.
        </p>
        <div className="animate-fade-in-up delay-400 mt-6">
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

      {/* Uptime */}
      <section className="mx-auto max-w-4xl px-6 pb-20 md:pb-28">
        <SectionLabel id="uptime">Uptime</SectionLabel>
        <h2 className="mb-8 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
          Uptime guarantee
        </h2>
        <div className="grid gap-6 md:grid-cols-2">
          {UPTIME_TIERS.map((tier) => (
            <MetricCard key={tier.plan} label={tier.plan} value={tier.target}>
              <ul className="space-y-2">
                <li className="flex items-start gap-2.5">
                  <CheckIcon />
                  <span className="text-sm text-zinc-400">
                    {tier.measurement}
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckIcon />
                  <span className="text-sm text-zinc-400">{tier.credit}</span>
                </li>
              </ul>
            </MetricCard>
          ))}
        </div>
        <div className="mt-6 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-6 md:p-8">
          <h3 className="mb-3 text-sm font-medium text-zinc-100">
            How we measure uptime
          </h3>
          <ul className="space-y-2">
            <li className="flex items-start gap-2.5">
              <CheckIcon />
              <span className="text-sm text-zinc-400">
                Monitored externally via{" "}
                <a
                  href={STATUS_PAGE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand/80 transition-colors hover:text-brand"
                >
                  OpenStatus
                </a>{" "}
                with 5-minute health check intervals
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <CheckIcon />
              <span className="text-sm text-zinc-400">
                Scheduled maintenance windows are excluded and announced at
                least 24 hours in advance
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <CheckIcon />
              <span className="text-sm text-zinc-400">
                Uptime percentage is calculated monthly:{" "}
                <span className="font-mono text-zinc-300">
                  (total minutes - downtime minutes) / total minutes
                </span>
              </span>
            </li>
          </ul>
        </div>
      </section>

      <Divider />

      {/* Latency */}
      <section className="mx-auto max-w-4xl px-6 py-20 md:py-28">
        <SectionLabel id="latency">Latency</SectionLabel>
        <h2 className="mb-8 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
          Query latency targets
        </h2>
        <div className="overflow-hidden rounded-xl border border-zinc-800/60">
          {LATENCY_TARGETS.map((target, i) => (
            <div
              key={target.metric}
              className={`flex flex-col gap-1 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4${
                i < LATENCY_TARGETS.length - 1
                  ? " border-b border-zinc-800/40"
                  : ""
              }`}
            >
              <div className="min-w-0">
                <p className="font-mono text-sm font-medium text-zinc-200">
                  {target.metric}
                </p>
                {target.note && (
                  <p className="mt-0.5 text-xs text-zinc-500">{target.note}</p>
                )}
              </div>
              <span className="shrink-0 font-mono text-sm font-medium text-brand/80">
                {target.target}
              </span>
            </div>
          ))}
        </div>
      </section>

      <Divider />

      {/* Support */}
      <section className="mx-auto max-w-4xl px-6 py-20 md:py-28">
        <SectionLabel id="support">Support</SectionLabel>
        <h2 className="mb-8 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
          Support response times
        </h2>

        {/* Desktop table */}
        <div className="hidden overflow-hidden rounded-xl border border-zinc-800/60 md:block">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800/60 bg-zinc-900/50">
                <th
                  scope="col"
                  className="px-6 py-4 text-left text-sm font-medium text-zinc-300"
                >
                  Plan
                </th>
                <th
                  scope="col"
                  className="px-6 py-4 text-center text-sm font-medium text-zinc-300"
                >
                  Critical
                </th>
                <th
                  scope="col"
                  className="px-6 py-4 text-center text-sm font-medium text-zinc-300"
                >
                  High
                </th>
                <th
                  scope="col"
                  className="px-6 py-4 text-center text-sm font-medium text-zinc-300"
                >
                  Normal
                </th>
                <th
                  scope="col"
                  className="px-6 py-4 text-center text-sm font-medium text-zinc-300"
                >
                  Channels
                </th>
              </tr>
            </thead>
            <tbody>
              {SUPPORT_TIERS.map((tier) => (
                <tr
                  key={tier.plan}
                  className="border-b border-zinc-800/40 last:border-0"
                >
                  <td className="px-6 py-3.5 font-mono text-sm font-medium text-zinc-200">
                    {tier.plan}
                  </td>
                  <td className="px-6 py-3.5 text-center text-sm text-zinc-400">
                    {tier.critical}
                  </td>
                  <td className="px-6 py-3.5 text-center text-sm text-zinc-400">
                    {tier.high}
                  </td>
                  <td className="px-6 py-3.5 text-center text-sm text-zinc-400">
                    {tier.normal}
                  </td>
                  <td className="px-6 py-3.5 text-center text-sm text-zinc-400">
                    {tier.channels}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="space-y-4 md:hidden">
          {SUPPORT_TIERS.map((tier) => (
            <div
              key={tier.plan}
              className="rounded-xl border border-zinc-800/60 bg-zinc-900/30"
            >
              <div className="border-b border-zinc-800/60 px-5 py-3">
                <h3 className="font-mono text-sm font-medium text-zinc-100">
                  {tier.plan}
                </h3>
              </div>
              <div className="divide-y divide-zinc-800/40 px-5">
                <div className="flex items-center justify-between py-3">
                  <span className="text-sm text-zinc-500">Critical</span>
                  <span className="text-sm text-zinc-400">{tier.critical}</span>
                </div>
                <div className="flex items-center justify-between py-3">
                  <span className="text-sm text-zinc-500">High</span>
                  <span className="text-sm text-zinc-400">{tier.high}</span>
                </div>
                <div className="flex items-center justify-between py-3">
                  <span className="text-sm text-zinc-500">Normal</span>
                  <span className="text-sm text-zinc-400">{tier.normal}</span>
                </div>
                <div className="flex items-center justify-between py-3">
                  <span className="text-sm text-zinc-500">Channels</span>
                  <span className="text-sm text-zinc-400">
                    {tier.channels}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-6 md:p-8">
          <h3 className="mb-3 text-sm font-medium text-zinc-100">
            Severity definitions
          </h3>
          <ul className="space-y-2">
            <li className="flex items-start gap-2.5">
              <CheckIcon />
              <span className="text-sm text-zinc-400">
                <span className="font-medium text-zinc-300">Critical</span> —
                Service is down or unusable for all users
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <CheckIcon />
              <span className="text-sm text-zinc-400">
                <span className="font-medium text-zinc-300">High</span> — Major
                feature is broken or significantly degraded
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <CheckIcon />
              <span className="text-sm text-zinc-400">
                <span className="font-medium text-zinc-300">Normal</span> —
                Non-blocking issue, question, or feature request
              </span>
            </li>
          </ul>
        </div>
      </section>

      <Divider />

      {/* Credits */}
      <section className="mx-auto max-w-4xl px-6 py-20 md:py-28">
        <SectionLabel id="credits">Credits</SectionLabel>
        <h2 className="mb-8 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
          Credit policy
        </h2>
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-6 md:p-8">
          <ul className="space-y-4">
            <li className="flex items-start gap-2.5">
              <CheckIcon />
              <span className="text-sm text-zinc-400">
                <span className="font-medium text-zinc-300">10x credit</span>{" "}
                for downtime exceeding your plan&apos;s SLA — e.g., 10 minutes
                of unplanned downtime = 100 minutes of service credit
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <CheckIcon />
              <span className="text-sm text-zinc-400">
                Credits are applied to your next billing cycle automatically
                after an incident is confirmed
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <CheckIcon />
              <span className="text-sm text-zinc-400">
                Maximum credit per month is capped at 30 days of service (100%
                of monthly fee)
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <CheckIcon />
              <span className="text-sm text-zinc-400">
                Credits do not apply to downtime caused by scheduled
                maintenance, third-party services, or customer-side
                configuration
              </span>
            </li>
          </ul>
        </div>
      </section>

      <Divider />

      {/* CTA */}
      <section className="mx-auto max-w-4xl px-6 py-20 text-center md:py-28">
        <h2 className="mb-4 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
          Questions about our SLA?
        </h2>
        <p className="mx-auto mb-8 max-w-xl text-zinc-400">
          For Enterprise customers, SLA terms are included in your contract.
          For questions about Team plan SLA coverage, reach out to support.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <a
            href="mailto:support@useatlas.dev"
            className="group inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-white"
          >
            Contact support
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

      <Footer />
    </div>
  );
}
