"use client";

import { useState } from "react";
import { ArrowIcon, CheckIcon, Divider, SectionLabel } from "../../components/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BillingPeriod = "monthly" | "annual";

interface Tier {
  name: string;
  monthlyPrice: number | null; // null = free
  tagline: string;
  badge?: string;
  cta: string;
  ctaHref: string;
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

interface FAQ {
  question: string;
  answer: string;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const TIERS: Tier[] = [
  {
    name: "Self-Hosted",
    monthlyPrice: null,
    tagline: "Deploy anywhere, your infrastructure",
    cta: "Deploy now",
    ctaHref: "https://docs.useatlas.dev/getting-started",
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
    name: "Starter",
    monthlyPrice: 29,
    tagline: "For individuals and small teams",
    badge: "14-day free trial",
    cta: "Start free trial",
    ctaHref: "https://app.useatlas.dev/signup?plan=starter",
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
    name: "Pro",
    monthlyPrice: 59,
    tagline: "For growing teams",
    badge: "14-day free trial",
    cta: "Start free trial",
    ctaHref: "https://app.useatlas.dev/signup?plan=pro",
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
    name: "Business",
    monthlyPrice: 99,
    tagline: "For organizations at scale",
    badge: "14-day free trial",
    cta: "Start free trial",
    ctaHref: "https://app.useatlas.dev/signup?plan=business",
    features: [
      "~750 AI queries/seat/mo included",
      "Unlimited seats",
      "Unlimited connections",
      "Default model: Sonnet 4.6",
      "BYOK for unlimited queries",
      "Notebooks & dashboards",
      "All 8 chat integrations",
      "Custom domain",
      "SSO & SCIM",
      "Data residency (3 regions)",
      "99.9% uptime SLA",
      "Priority + Slack support",
    ],
  },
];

const COMPARISON: ComparisonRow[] = [
  // Core features
  { feature: "Text-to-SQL agent", selfHosted: true, starter: true, pro: true, business: true },
  { feature: "Semantic layer", selfHosted: true, starter: true, pro: true, business: true },
  { feature: "All databases & plugins", selfHosted: true, starter: true, pro: true, business: true },
  { feature: "Notebooks", selfHosted: true, starter: true, pro: true, business: true },
  { feature: "Dashboards", selfHosted: true, starter: true, pro: true, business: true },
  { feature: "Admin console & API", selfHosted: true, starter: true, pro: true, business: true },
  { feature: "MCP server", selfHosted: true, starter: true, pro: true, business: true },
  // Limits
  { feature: "AI queries/seat/mo", selfHosted: "Unlimited (BYOK)", starter: "~100", pro: "~250", business: "~750" },
  { feature: "BYOK (unlimited queries)", selfHosted: "Default", starter: true, pro: true, business: true },
  { feature: "Default model", selfHosted: "Your choice", starter: "Haiku 4.5", pro: "Sonnet 4.6", business: "Sonnet 4.6" },
  { feature: "Seats", selfHosted: "Unlimited", starter: "Up to 10", pro: "Up to 25", business: "Unlimited" },
  { feature: "Database connections", selfHosted: "Unlimited", starter: "1", pro: "3", business: "Unlimited" },
  { feature: "Extra connections", selfHosted: false, starter: "+$10/mo each", pro: "+$10/mo each", business: "Included" },
  { feature: "Chat integrations", selfHosted: "Config-based", starter: "1 platform", pro: "3 platforms", business: "All 8" },
  { feature: "Overage rate", selfHosted: false, starter: "$0.10/query", pro: "$0.08/query", business: "$0.06/query" },
  // Enterprise features
  { feature: "Custom domain", selfHosted: false, starter: false, pro: true, business: true },
  { feature: "SSO & SCIM", selfHosted: false, starter: false, pro: false, business: true },
  { feature: "Data residency", selfHosted: false, starter: false, pro: false, business: "3 regions" },
  { feature: "Uptime SLA", selfHosted: false, starter: false, pro: false, business: "99.9%" },
  { feature: "Support", selfHosted: "Community", starter: "Email", pro: "Priority email", business: "Priority + Slack" },
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
      "You'll get warnings as you approach your limit. Once reached, additional queries are billed at your plan's overage rate ($0.10, $0.08, or $0.06 per query). No hard cutoffs — your team keeps working. You can also switch to BYOK at any time to avoid overages entirely.",
  },
  {
    question: "Is there a free option?",
    answer:
      "Yes — self-hosted Atlas is free and always will be (AGPL-3.0). Deploy on your own infrastructure with unlimited everything. For Atlas Cloud, all paid plans include a 14-day free trial with no credit card required.",
  },
  {
    question: "Do you offer annual billing?",
    answer:
      "Yes. Annual billing saves you 2 months (pay for 10, get 12). Toggle the billing period at the top of this page to see annual prices.",
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
// Helper: price formatting
// ---------------------------------------------------------------------------

function formatPrice(monthlyPrice: number | null, billing: BillingPeriod): { price: string; suffix: string } {
  if (monthlyPrice === null) {
    return { price: "Free", suffix: "forever" };
  }
  if (billing === "annual") {
    // 10 months for 12 — show effective monthly rate
    const annualTotal = monthlyPrice * 10;
    const effectiveMonthly = Math.round(annualTotal / 12);
    return { price: `$${effectiveMonthly}`, suffix: "/ seat / mo" };
  }
  return { price: `$${monthlyPrice}`, suffix: "/ seat / mo" };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function DashIcon() {
  return (
    <svg
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
    </svg>
  );
}

function BillingToggle({
  billing,
  onChange,
}: {
  billing: BillingPeriod;
  onChange: (period: BillingPeriod) => void;
}) {
  return (
    <div className="animate-fade-in-up delay-300 mb-10 flex items-center justify-center gap-3">
      <button
        type="button"
        onClick={() => onChange("monthly")}
        className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
          billing === "monthly"
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-500 hover:text-zinc-300"
        }`}
      >
        Monthly
      </button>
      <button
        type="button"
        onClick={() => onChange("annual")}
        className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
          billing === "annual"
            ? "bg-zinc-800 text-zinc-100"
            : "text-zinc-500 hover:text-zinc-300"
        }`}
      >
        Annual
        <span className="rounded-full bg-brand/10 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-brand">
          2 months free
        </span>
      </button>
    </div>
  );
}

function TierCard({ tier, billing }: { tier: Tier; billing: BillingPeriod }) {
  const { price, suffix } = formatPrice(tier.monthlyPrice, billing);

  let ctaStyle: string;
  if (tier.highlighted) {
    ctaStyle = "bg-brand text-zinc-950 hover:bg-brand-hover";
  } else if (tier.monthlyPrice === null) {
    ctaStyle = "bg-zinc-100 text-zinc-950 hover:bg-white";
  } else {
    ctaStyle = "border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100";
  }

  // Show annual total for paid plans on annual billing
  const showAnnualTotal = billing === "annual" && tier.monthlyPrice !== null;
  const annualTotal = tier.monthlyPrice !== null ? tier.monthlyPrice * 10 : 0;

  return (
    <div
      className={`flex flex-col rounded-xl p-6 md:p-8 ${
        tier.highlighted
          ? "cloud-glow bg-zinc-900/50"
          : "border border-zinc-800/60 bg-zinc-900/30"
      }`}
    >
      <div className="mb-1">
        <span className="font-mono text-xs tracking-widest text-brand/80 uppercase">
          {tier.name}
        </span>
      </div>
      {tier.badge && (
        <div className="mb-2">
          <span className="inline-block rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-brand uppercase">
            {tier.badge}
          </span>
        </div>
      )}
      <div className="mb-0.5 flex items-baseline gap-1.5">
        <span className="text-3xl font-semibold tracking-tight text-zinc-100">
          {price}
        </span>
        <span className="text-sm text-zinc-500">{suffix}</span>
      </div>
      {showAnnualTotal && (
        <p className="mb-1 text-xs text-zinc-600">
          ${annualTotal}/seat billed annually
        </p>
      )}
      <p className="mb-5 text-sm leading-relaxed text-zinc-400">
        {tier.tagline}
      </p>
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
          className={`group inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-all ${ctaStyle}`}
        >
          {tier.cta}
          <ArrowIcon />
        </a>
      </div>
    </div>
  );
}

function ComparisonCell({ value }: { value: CellValue }) {
  if (typeof value === "string") {
    return <span className="text-sm text-zinc-400">{value}</span>;
  }
  return value ? <CheckIcon /> : <DashIcon />;
}

function FAQItem({ faq }: { faq: FAQ }) {
  return (
    <div className="border-b border-zinc-800/60 py-6 last:border-0 last:pb-0">
      <h3 className="mb-2 text-sm font-medium text-zinc-100">{faq.question}</h3>
      <p className="text-sm leading-relaxed text-zinc-400">{faq.answer}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function PricingContent() {
  const [billing, setBilling] = useState<BillingPeriod>("monthly");
  const faqHalf = Math.ceil(FAQS.length / 2);

  return (
    <>
      {/* Billing toggle + Tier cards */}
      <section className="mx-auto max-w-6xl px-6 pb-20 md:pb-28">
        <BillingToggle billing={billing} onChange={setBilling} />

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {TIERS.map((tier) => (
            <TierCard key={tier.name} tier={tier} billing={billing} />
          ))}
        </div>
      </section>

      {/* BYOK callout */}
      <section className="mx-auto max-w-6xl px-6 pb-20 md:pb-28">
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-8 md:flex md:items-center md:gap-8 md:p-10">
          <div className="mb-6 flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-zinc-800 text-brand md:mb-0">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
            </svg>
          </div>
          <div>
            <h3 className="mb-2 text-base font-semibold text-zinc-100">
              Bring your own API key for unlimited queries on any plan
            </h3>
            <p className="text-sm leading-relaxed text-zinc-400">
              Use your own Anthropic, OpenAI, or other LLM API keys instead of included query credits.
              You pay the LLM provider directly at their rates — your Atlas bill only covers
              infrastructure. Available on every paid plan. Self-hosted always uses your own keys.
            </p>
          </div>
        </div>
      </section>

      <Divider />

      {/* Feature comparison table */}
      <section className="mx-auto max-w-6xl px-6 py-20 md:py-28">
        <SectionLabel>Compare plans</SectionLabel>
        <h2 className="mb-10 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
          Feature comparison
        </h2>

        {/* Desktop table */}
        <div className="hidden overflow-hidden rounded-xl border border-zinc-800/60 lg:block">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800/60 bg-zinc-900/50">
                <th scope="col" className="px-5 py-4 text-left text-sm font-medium text-zinc-300">Feature</th>
                <th scope="col" className="px-5 py-4 text-center text-sm font-medium text-zinc-300">Self-Hosted</th>
                <th scope="col" className="px-5 py-4 text-center text-sm font-medium text-zinc-300">Starter</th>
                <th scope="col" className="px-5 py-4 text-center text-sm font-medium text-zinc-300">Pro</th>
                <th scope="col" className="px-5 py-4 text-center text-sm font-medium text-zinc-300">Business</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.feature} className="border-b border-zinc-800/40 last:border-0">
                  <td className="px-5 py-3.5 text-sm text-zinc-400">{row.feature}</td>
                  <td className="px-5 py-3.5 text-center">
                    <span className="inline-flex justify-center"><ComparisonCell value={row.selfHosted} /></span>
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <span className="inline-flex justify-center"><ComparisonCell value={row.starter} /></span>
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <span className="inline-flex justify-center"><ComparisonCell value={row.pro} /></span>
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <span className="inline-flex justify-center"><ComparisonCell value={row.business} /></span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile comparison (stacked cards) */}
        <div className="space-y-6 lg:hidden">
          {TIER_KEYS.map((tierKey) => (
            <div key={tierKey} className="rounded-xl border border-zinc-800/60 bg-zinc-900/30">
              <div className="border-b border-zinc-800/60 px-5 py-3">
                <h3 className="font-mono text-sm font-medium text-zinc-100">{TIER_LABELS[tierKey]}</h3>
              </div>
              <div className="divide-y divide-zinc-800/40 px-5">
                {COMPARISON.map((row) => (
                  <div key={row.feature} className="flex items-center justify-between py-3">
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
      </section>

      <Divider />

      {/* FAQ */}
      <section className="mx-auto max-w-6xl px-6 py-20 md:py-28">
        <SectionLabel>FAQ</SectionLabel>
        <h2 className="mb-8 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
          Common questions
        </h2>
        <div className="grid gap-0 md:grid-cols-2 md:gap-x-12">
          <div>
            {FAQS.slice(0, faqHalf).map((faq) => (
              <FAQItem key={faq.question} faq={faq} />
            ))}
          </div>
          <div className="border-t border-zinc-800/60 md:border-0">
            {FAQS.slice(faqHalf).map((faq) => (
              <FAQItem key={faq.question} faq={faq} />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
