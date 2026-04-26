"use client";

import { useState } from "react";
import { ArrowIcon, CheckIcon } from "../../components/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BillingPeriod = "monthly" | "annual";
type Currency = "USD" | "EUR" | "GBP";

interface Tier {
  kind: string;
  name: string;
  monthlyPrice: number | null; // null = free
  tagline: string;
  badge?: string;
  cta: string;
  ctaHref: string;
  ctaSecondary: string;
  highlighted?: boolean;
  features: string[];
}

type TierKey = "selfHosted" | "starter" | "pro" | "business";
type CellValue = boolean | string;

interface ComparisonRow {
  feature: string;
  selfHosted: CellValue;
  starter: CellValue;
  pro: CellValue;
  business: CellValue;
}

interface ComparisonSection {
  label: string;
  rows: ComparisonRow[];
}

interface FAQ {
  question: string;
  answer: string;
}

// ---------------------------------------------------------------------------
// FX rates — display-only courtesy conversion. Stripe billing is in USD.
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOL: Record<Currency, string> = { USD: "$", EUR: "€", GBP: "£" };
const CURRENCY_RATE: Record<Currency, number> = { USD: 1, EUR: 0.92, GBP: 0.79 };

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const TIERS: Tier[] = [
  {
    kind: "open source",
    name: "Self-Hosted",
    monthlyPrice: null,
    tagline: "Your infra. Your data.",
    cta: "Deploy now",
    ctaHref: "https://docs.useatlas.dev/getting-started",
    ctaSecondary: "Free, AGPL-3.0",
    features: [
      "BYOK — unlimited queries",
      "Unlimited seats",
      "Unlimited connections",
      "Your choice of model",
      "Notebooks & dashboards",
      "Config-based chat integrations",
      "Community support",
    ],
  },
  {
    kind: "atlas cloud",
    name: "Starter",
    monthlyPrice: 29,
    tagline: "Solo + small teams.",
    badge: "14-day free trial",
    cta: "Start free trial",
    ctaHref: "https://app.useatlas.dev/signup?plan=starter",
    ctaSecondary: "no card required",
    features: [
      "~100 AI queries/seat/mo included",
      "Up to 10 seats",
      "1 database connection",
      "Default model: Haiku 4.5",
      "BYOK for unlimited queries",
      "Notebooks & dashboards",
      "1 chat integration",
      "Email support",
    ],
  },
  {
    kind: "atlas cloud",
    name: "Pro",
    monthlyPrice: 59,
    tagline: "Growing teams.",
    badge: "14-day free trial",
    cta: "Start free trial",
    ctaHref: "https://app.useatlas.dev/signup?plan=pro",
    ctaSecondary: "no card required",
    highlighted: true,
    features: [
      "~250 AI queries/seat/mo included",
      "Up to 25 seats",
      "3 database connections",
      "Default model: Sonnet 4.6",
      "BYOK for unlimited queries",
      "Notebooks & dashboards",
      "3 chat integrations",
      "Custom domain",
      "Priority email support",
    ],
  },
  {
    kind: "enterprise",
    name: "Business",
    monthlyPrice: 99,
    tagline: "Regulated teams at scale.",
    badge: "14-day free trial",
    cta: "Start free trial",
    ctaHref: "https://app.useatlas.dev/signup?plan=business",
    ctaSecondary: "or talk to sales",
    features: [
      "~750 AI queries/seat/mo included",
      "Unlimited seats & connections",
      "Default model: Sonnet 4.6",
      "BYOK for unlimited queries",
      "All 8 chat integrations",
      "SSO, SCIM & custom roles",
      "IP allowlist & approval workflows",
      "PII masking & audit retention",
      "Compliance reports (SOC2 / HIPAA)",
      "Automated backups",
      "White-label branding",
      "Custom domain",
      "Data residency (3 regions)",
      "99.9% uptime SLA",
      "Priority + Slack support",
    ],
  },
];

const COMPARISON_SECTIONS: ComparisonSection[] = [
  {
    label: "core",
    rows: [
      { feature: "Text-to-SQL agent", selfHosted: true, starter: true, pro: true, business: true },
      { feature: "Semantic layer", selfHosted: true, starter: true, pro: true, business: true },
      { feature: "All databases & plugins", selfHosted: true, starter: true, pro: true, business: true },
      { feature: "Notebooks & dashboards", selfHosted: true, starter: true, pro: true, business: true },
      { feature: "Admin console & API", selfHosted: true, starter: true, pro: true, business: true },
      { feature: "MCP server", selfHosted: true, starter: true, pro: true, business: true },
      { feature: "AI queries/seat/mo", selfHosted: "Unlimited (BYOK)", starter: "~100", pro: "~250", business: "~750" },
      { feature: "BYOK (unlimited queries)", selfHosted: "Default", starter: true, pro: true, business: true },
      { feature: "Default model", selfHosted: "Your choice", starter: "Haiku 4.5", pro: "Sonnet 4.6", business: "Sonnet 4.6" },
      { feature: "Seats", selfHosted: "Unlimited", starter: "Up to 10", pro: "Up to 25", business: "Unlimited" },
      { feature: "Database connections", selfHosted: "Unlimited", starter: "1", pro: "3", business: "Unlimited" },
      { feature: "Extra connections", selfHosted: false, starter: "+$10/mo each", pro: "+$10/mo each", business: "Included" },
      { feature: "Chat integrations", selfHosted: "Config-based", starter: "1 platform", pro: "3 platforms", business: "All 8" },
      { feature: "Overage rate", selfHosted: false, starter: "$0.10/query", pro: "$0.10/query", business: "$0.10/query" },
    ],
  },
  {
    label: "hosting",
    rows: [
      { feature: "Custom domain", selfHosted: false, starter: false, pro: true, business: true },
      { feature: "White-label branding", selfHosted: false, starter: false, pro: false, business: true },
      { feature: "Data residency", selfHosted: false, starter: false, pro: false, business: "3 regions" },
      { feature: "Uptime SLA", selfHosted: false, starter: false, pro: false, business: "99.9%" },
      { feature: "Automated backups", selfHosted: false, starter: false, pro: false, business: true },
    ],
  },
  {
    label: "security & compliance",
    rows: [
      { feature: "SSO (SAML + OIDC)", selfHosted: false, starter: false, pro: false, business: true },
      { feature: "SCIM directory sync", selfHosted: false, starter: false, pro: false, business: true },
      { feature: "Custom roles & permissions", selfHosted: false, starter: false, pro: false, business: true },
      { feature: "IP allowlisting", selfHosted: false, starter: false, pro: false, business: true },
      { feature: "Approval workflows", selfHosted: false, starter: false, pro: false, business: true },
      { feature: "Audit log retention policies", selfHosted: false, starter: false, pro: false, business: true },
      { feature: "PII detection & masking", selfHosted: false, starter: false, pro: false, business: true },
      { feature: "Compliance reports (SOC2/HIPAA)", selfHosted: false, starter: false, pro: false, business: true },
    ],
  },
  {
    label: "support",
    rows: [
      { feature: "Support channel", selfHosted: "Community", starter: "Email", pro: "Priority email", business: "Priority + Slack" },
    ],
  },
];

const FAQS: FAQ[] = [
  {
    question: "What counts as a query?",
    answer:
      "An AI query is one round-trip where Atlas generates and executes SQL against your database. Browsing the admin console, viewing notebooks, or editing the semantic layer does not consume queries. Only AI-generated SQL executions count.",
  },
  {
    question: "What is BYOK (bring your own key)?",
    answer:
      "BYOK lets you use your own LLM API keys (Anthropic, OpenAI, etc.) instead of our included queries. You pay the LLM provider directly at their rates, but your queries become unlimited on any paid plan. Self-hosted users always use their own keys.",
  },
  {
    question: "Can I switch models?",
    answer:
      "Yes. Every plan lets you choose any supported model (Claude, GPT, etc.). On paid plans, your per-seat query budget adjusts automatically based on the model's cost — a more expensive model uses more budget per query, a cheaper one uses less.",
  },
  {
    question: "What happens when I hit my query limit?",
    answer:
      "You'll get warnings as you approach your limit. You have a 10% grace buffer beyond your included budget, and additional queries in that range are billed at $0.10 per query. To avoid overages entirely, switch to BYOK at any time — your own API key means unlimited queries.",
  },
  {
    question: "Is there a free option?",
    answer:
      "Yes — self-hosted Atlas is free and always will be (AGPL-3.0). Deploy on your own infrastructure with unlimited everything. For Atlas Cloud, all paid plans include a 14-day free trial with no credit card required.",
  },
  {
    question: "Do you offer annual billing?",
    answer:
      "Yes. Annual billing saves ~17% (10 months for 12). Toggle the billing period at the top of this page to see annual prices.",
  },
  {
    question: "Can I add more database connections?",
    answer:
      "Starter and Pro plans can add extra connections for $10/month each. Business plans include unlimited connections.",
  },
  {
    question: "Can I change plans later?",
    answer:
      "Yes. Upgrade or downgrade anytime from the billing page in your admin console. Changes take effect at the start of your next billing cycle.",
  },
];

const TIER_KEYS: TierKey[] = ["selfHosted", "starter", "pro", "business"];

const TIER_LABELS: Record<TierKey, string> = {
  selfHosted: "Self-Hosted",
  starter: "Starter",
  pro: "Pro",
  business: "Business",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPrice(
  monthlyPrice: number | null,
  billing: BillingPeriod,
  currency: Currency,
): { price: string; suffix: string; annualTotal?: string } {
  if (monthlyPrice === null) {
    return { price: "Free", suffix: "forever" };
  }
  const symbol = CURRENCY_SYMBOL[currency];
  const rate = CURRENCY_RATE[currency];
  if (billing === "annual") {
    // 10 months billed for 12. We round at the annual-total level so the
    // displayed total matches Stripe's actual charge, then derive the
    // per-month for tier-to-tier comparison.
    const annual = Math.round(monthlyPrice * 10 * rate);
    const effectiveMonthly = Math.round(annual / 12);
    return {
      price: `${symbol}${effectiveMonthly}`,
      suffix: "/ seat / mo",
      annualTotal: `${symbol}${annual} per seat, billed yearly`,
    };
  }
  return { price: `${symbol}${Math.round(monthlyPrice * rate)}`, suffix: "/ seat / mo" };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DashIcon() {
  return (
    <svg
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
    </svg>
  );
}

function BillingCurrencyToggle({
  billing,
  currency,
  onBillingChange,
  onCurrencyChange,
}: {
  billing: BillingPeriod;
  currency: Currency;
  onBillingChange: (period: BillingPeriod) => void;
  onCurrencyChange: (c: Currency) => void;
}) {
  return (
    <div className="animate-fade-in-up delay-300 mb-8 flex flex-col items-center justify-center gap-4 sm:flex-row sm:gap-6">
      <div
        role="group"
        aria-label="Billing period"
        className="inline-flex rounded-full border border-zinc-800 bg-zinc-900/60 p-1"
      >
        {(["monthly", "annual"] as const).map((period) => (
          <button
            key={period}
            type="button"
            aria-pressed={billing === period}
            onClick={() => onBillingChange(period)}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm transition-colors ${
              billing === period
                ? "bg-brand font-semibold text-zinc-950"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {period === "monthly" ? "Monthly" : "Annual"}
            {period === "annual" && (
              <span
                className={`rounded-full px-1.5 py-0.5 font-mono text-[9.5px] tracking-wider ${
                  billing === "annual"
                    ? "bg-zinc-950/25 text-zinc-950"
                    : "bg-brand/15 text-brand"
                }`}
              >
                save 17%
              </span>
            )}
          </button>
        ))}
      </div>

      <div role="group" aria-label="Display currency" className="flex gap-1">
        {(Object.keys(CURRENCY_SYMBOL) as Currency[]).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={currency === c}
            onClick={() => onCurrencyChange(c)}
            className={`rounded-md border px-2.5 py-1 font-mono text-[11px] tracking-wider transition-colors ${
              currency === c
                ? "border-brand/40 text-brand"
                : "border-zinc-800 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {CURRENCY_SYMBOL[c]} {c}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatCard() {
  return (
    <div className="animate-fade-in-up delay-400 mb-10 grid items-center gap-6 rounded-xl border border-brand/25 bg-brand/4 p-6 md:grid-cols-[auto_1fr] md:gap-7 md:p-7">
      <div className="font-mono text-5xl font-semibold tracking-tight text-brand md:text-[60px]">
        94%
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-base leading-snug font-medium text-zinc-100 md:text-[17px]">
          of AI-generated SQL fails at least one Atlas validator.
        </p>
        <p className="font-mono text-[11.5px] leading-relaxed tracking-wider text-zinc-400">
          Sample: 12,418 queries across our beta cohort. Every tier ships the same
          7 gates — the difference is who runs the servers.
        </p>
      </div>
    </div>
  );
}

function TierCard({
  tier,
  billing,
  currency,
}: {
  tier: Tier;
  billing: BillingPeriod;
  currency: Currency;
}) {
  const { price, suffix, annualTotal } = formatPrice(tier.monthlyPrice, billing, currency);

  let ctaStyle: string;
  if (tier.highlighted) {
    ctaStyle = "bg-brand text-zinc-950 hover:bg-brand-hover";
  } else if (tier.monthlyPrice === null) {
    ctaStyle = "bg-zinc-100 text-zinc-950 hover:bg-white";
  } else {
    ctaStyle = "border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100";
  }

  return (
    <div
      className={`relative flex flex-col rounded-2xl p-6 md:p-7 ${
        tier.highlighted
          ? "cloud-glow bg-zinc-900/55"
          : "border border-zinc-800/60 bg-zinc-900/30"
      }`}
    >
      <div className="mb-2 font-mono text-[11px] tracking-wider text-zinc-400 uppercase">
        // {tier.kind}
      </div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-100">
          {tier.name}
        </h2>
        {tier.highlighted && (
          <span className="rounded-full border border-brand/60 px-2 py-0.5 font-mono text-[9.5px] tracking-wider text-brand uppercase">
            recommended
          </span>
        )}
      </div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[44px] leading-none font-semibold tracking-tight text-zinc-100">
          {price}
        </span>
        <span className="text-xs text-zinc-400">{suffix}</span>
      </div>
      {annualTotal && (
        <p className="mb-3 font-mono text-[11px] tracking-wider text-zinc-400">
          {annualTotal}
        </p>
      )}
      <p className="mb-5 text-sm leading-relaxed text-zinc-400">{tier.tagline}</p>
      <ul className="mb-6 space-y-2.5">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5">
            <CheckIcon />
            <span className="text-sm text-zinc-400">{feature}</span>
          </li>
        ))}
      </ul>
      <div className="mt-auto">
        <a
          href={tier.ctaHref}
          className={`group inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-all ${ctaStyle}`}
        >
          {tier.cta}
          <ArrowIcon />
        </a>
        <p className="mt-2.5 text-center font-mono text-[10.5px] tracking-wider text-zinc-400">
          {tier.ctaSecondary}
        </p>
      </div>
    </div>
  );
}

function ComparisonCell({ value }: { value: CellValue }) {
  if (typeof value === "string") {
    return <span className="font-mono text-xs text-zinc-300">{value}</span>;
  }
  return value ? <CheckIcon /> : <DashIcon />;
}

function FAQCard({ faq }: { faq: FAQ }) {
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-5 md:p-6">
      <h3 className="mb-2 text-[15px] font-semibold text-zinc-100">{faq.question}</h3>
      <p className="text-sm leading-relaxed text-zinc-400">{faq.answer}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function PricingContent() {
  const [billing, setBilling] = useState<BillingPeriod>("annual");
  const [currency, setCurrency] = useState<Currency>("USD");

  return (
    <>
      {/* Toggles + stat card + tier cards */}
      <section className="mx-auto max-w-6xl px-6 pb-16 md:pb-24">
        <BillingCurrencyToggle
          billing={billing}
          currency={currency}
          onBillingChange={setBilling}
          onCurrencyChange={setCurrency}
        />

        <StatCard />

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {TIERS.map((tier) => (
            <TierCard key={tier.name} tier={tier} billing={billing} currency={currency} />
          ))}
        </div>

        {currency !== "USD" && (
          <p className="mt-5 text-center font-mono text-[10.5px] tracking-wider text-zinc-400">
            Billed in USD; {currency} shown at indicative rates for reference.
          </p>
        )}
      </section>

      {/* Feature comparison */}
      <section
        aria-labelledby="compare-plans-heading"
        className="mx-auto max-w-6xl px-6 py-16 md:py-24"
      >
        <p className="mb-3 font-mono text-xs tracking-widest text-brand/80 uppercase">
          // detailed comparison
        </p>
        <h2
          id="compare-plans-heading"
          className="mb-10 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl"
        >
          What you get at every tier.
        </h2>

        <div className="hidden overflow-hidden rounded-xl border border-zinc-800/60 lg:block">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800/60 bg-zinc-900/50">
                <th
                  scope="col"
                  className="px-5 py-4 text-left font-mono text-[11px] tracking-widest text-zinc-400 uppercase"
                >
                  feature
                </th>
                <th
                  scope="col"
                  className="px-5 py-4 text-center font-mono text-[11px] tracking-widest text-zinc-300 uppercase"
                >
                  Self-Hosted
                </th>
                <th
                  scope="col"
                  className="px-5 py-4 text-center font-mono text-[11px] tracking-widest text-zinc-300 uppercase"
                >
                  Starter
                </th>
                <th
                  scope="col"
                  className="bg-brand/4 px-5 py-4 text-center font-mono text-[11px] tracking-widest text-brand uppercase"
                >
                  Pro
                </th>
                <th
                  scope="col"
                  className="px-5 py-4 text-center font-mono text-[11px] tracking-widest text-zinc-300 uppercase"
                >
                  Business
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON_SECTIONS.map((section, i) => (
                <SectionRows key={section.label} section={section} isFirst={i === 0} />
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile / tablet — stacked per-tier */}
        <div className="space-y-6 lg:hidden">
          {TIER_KEYS.map((tierKey) => (
            <div
              key={tierKey}
              className={`overflow-hidden rounded-xl border bg-zinc-900/30 ${
                tierKey === "pro" ? "border-brand/40" : "border-zinc-800/60"
              }`}
            >
              <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 px-5 py-3">
                <h3 className="font-mono text-sm font-medium text-zinc-100">
                  {TIER_LABELS[tierKey]}
                </h3>
                {tierKey === "pro" && (
                  <span className="rounded-full border border-brand/60 px-2 py-0.5 font-mono text-[9.5px] tracking-wider text-brand uppercase">
                    recommended
                  </span>
                )}
              </div>
              <div className="px-5 pb-2">
                {COMPARISON_SECTIONS.map((section) => (
                  <div key={section.label}>
                    <p className="mt-3 mb-1 font-mono text-[10.5px] tracking-widest text-brand/80 uppercase">
                      // {section.label}
                    </p>
                    <div className="divide-y divide-zinc-800/40">
                      {section.rows.map((row) => (
                        <div key={row.feature} className="flex items-center justify-between py-2.5">
                          <span className="text-sm text-zinc-400">{row.feature}</span>
                          <span className="ml-4 shrink-0">
                            <ComparisonCell value={row[tierKey]} />
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section
        aria-labelledby="pricing-faq-heading"
        className="mx-auto max-w-6xl px-6 py-16 md:py-24"
      >
        <p className="mb-3 font-mono text-xs tracking-widest text-brand/80 uppercase">
          // frequently asked
        </p>
        <h2
          id="pricing-faq-heading"
          className="mb-8 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl"
        >
          Pricing questions.
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {FAQS.map((faq) => (
            <FAQCard key={faq.question} faq={faq} />
          ))}
        </div>
      </section>
    </>
  );
}

function SectionRows({ section, isFirst }: { section: ComparisonSection; isFirst: boolean }) {
  return (
    <>
      <tr>
        <th
          colSpan={5}
          scope="colgroup"
          className={`bg-zinc-900/30 px-5 pt-5 pb-2 text-left font-mono text-[10.5px] tracking-widest text-brand/80 uppercase ${
            isFirst ? "" : "border-t border-zinc-800/40"
          }`}
        >
          // {section.label}
        </th>
      </tr>
      {section.rows.map((row) => (
        <tr key={row.feature} className="border-b border-zinc-800/30 last:border-0">
          <td className="px-5 py-3 text-sm text-zinc-300">{row.feature}</td>
          <td className="px-5 py-3 text-center">
            <span className="inline-flex justify-center">
              <ComparisonCell value={row.selfHosted} />
            </span>
          </td>
          <td className="px-5 py-3 text-center">
            <span className="inline-flex justify-center">
              <ComparisonCell value={row.starter} />
            </span>
          </td>
          <td className="bg-brand/4 px-5 py-3 text-center">
            <span className="inline-flex justify-center">
              <ComparisonCell value={row.pro} />
            </span>
          </td>
          <td className="px-5 py-3 text-center">
            <span className="inline-flex justify-center">
              <ComparisonCell value={row.business} />
            </span>
          </td>
        </tr>
      ))}
    </>
  );
}
