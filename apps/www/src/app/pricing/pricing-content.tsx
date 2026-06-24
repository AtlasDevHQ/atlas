"use client";

import { useState } from "react";
import { ArrowIcon, CheckIcon } from "../../components/shared";
import { TalkToSalesDialog } from "../../components/talk-to-sales-dialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BillingPeriod = "monthly" | "annual";

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
// Data
// ---------------------------------------------------------------------------

const TIERS: Tier[] = [
  {
    kind: "open source",
    name: "Self-Hosted",
    monthlyPrice: null,
    tagline: "Your infra. Your data.",
    cta: "Deploy now",
    ctaHref: "https://docs.useatlas.dev/getting-started/quick-start",
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
    ctaSecondary: "no card · work email",
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
    ctaSecondary: "no card · work email",
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
      "All 8 integrations (6 chat + Linear + GitHub)",
      "SSO, SCIM & custom roles",
      "IP allowlist & approval workflows",
      "PII masking & audit retention",
      "Automated backups",
      "White-label branding",
      "Custom domain",
      "Data residency (3 regions)",
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
      { feature: "Chat integrations", selfHosted: "Config-based", starter: "1 platform", pro: "3 platforms", business: "All 6" },
      { feature: "When you hit the budget", selfHosted: "No limit (BYOK)", starter: "Warn → 10% grace → pause", pro: "Warn → 10% grace → pause", business: "Warn → 10% grace → pause" },
    ],
  },
  {
    label: "hosting",
    rows: [
      { feature: "Custom domain", selfHosted: false, starter: false, pro: true, business: true },
      { feature: "White-label branding", selfHosted: false, starter: false, pro: false, business: true },
      { feature: "Data residency", selfHosted: false, starter: false, pro: false, business: "3 regions" },
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
      "Yes. Every plan lets you choose any supported model (Claude, GPT, etc.). Your per-seat budget is a flat token count — every token counts the same regardless of which model produced it, so a more capable model simply consumes the shared budget faster. Switch to BYOK to remove token limits entirely.",
  },
  {
    question: "What happens when I hit my token budget?",
    answer:
      "Each paid plan includes a per-seat monthly token budget that scales with your seat count. As you approach it you'll get a usage warning (from ~80%), and you keep working through a 10% grace buffer past 100%. At 110% new requests are paused until you upgrade, add seats, or your billing period resets. There is no metered per-token overage charge — it's a hard cap with a grace buffer, not pay-as-you-go. To remove token limits entirely, switch to BYOK at any time and use your own API key.",
  },
  {
    question: "Is there a free option?",
    answer:
      "Yes — self-hosted Atlas is free and always will be (AGPL-3.0). Deploy on your own infrastructure with unlimited everything. For Atlas Cloud, all paid plans include a 14-day free trial with no credit card required (work email required — see below). Every trial runs at Starter-tier usage limits (2M tokens/seat, up to 10 seats, 1 connection) for 14 days, regardless of the plan you start from.",
  },
  {
    question: "What email can I sign up with?",
    answer:
      "Atlas Cloud signup requires a business (work) email. Disposable-mailbox and consumer freemium domains (gmail.com, outlook.com, yahoo.com, and similar) are not accepted, on both the web form and the MCP start_trial flow. Use your company address. Self-hosted Atlas has no such restriction.",
  },
  {
    question: "How does the trial work over MCP?",
    answer:
      "You can start a trial directly from your MCP client (Claude Desktop, Cursor, etc.) with the start_trial tool — no web visit needed to begin. That workspace starts metered: you can set it up and run SQL, but Atlas-token Q&A is held until you claim the account on the web (verify your email and set a credential). Claiming starts your full 14-day clock; an unclaimed workspace runs on a short grace window and expires if it's never claimed. Signing up on the web claims the account in the same step.",
  },
  {
    question: "Do you offer annual billing?",
    answer:
      "Yes. Annual billing saves ~17% (10 months for 12). Toggle the billing period at the top of this page to see annual prices.",
  },
  {
    question: "Can I add more database connections?",
    answer:
      "Starter includes 1 connection and Pro includes 3. Business includes unlimited connections. If you need more on Starter or Pro, upgrade your plan or contact sales.",
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
): { price: string; suffix: string; annualTotal?: string } {
  if (monthlyPrice === null) {
    return { price: "Free", suffix: "forever" };
  }
  // All prices are shown and billed in USD.
  if (billing === "annual") {
    // ASSUMPTION: STRIPE_*_ANNUAL_PRICE_ID products are configured as
    // exactly 10 × monthly (≈17% off, "10 months for 12"). The toggle copy
    // and FAQ both depend on this. If you change Stripe's annual prices,
    // update this multiplier and the "save 17%" / FAQ copy together.
    const annual = monthlyPrice * 10;
    const effectiveMonthly = Math.round(annual / 12);
    return {
      price: `$${effectiveMonthly}`,
      suffix: "/ seat / mo",
      annualTotal: `$${annual} per seat, billed yearly`,
    };
  }
  return { price: `$${monthlyPrice}`, suffix: "/ seat / mo" };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DashIcon() {
  return (
    <svg
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-faint"
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

function BillingToggle({
  billing,
  onBillingChange,
}: {
  billing: BillingPeriod;
  onBillingChange: (period: BillingPeriod) => void;
}) {
  return (
    <div className="animate-fade-in-up delay-300 mb-8 flex items-center justify-center">
      <div
        role="group"
        aria-label="Billing period"
        className="inline-flex rounded-full border border-border bg-bg-raised p-1"
      >
        {(["monthly", "annual"] as const).map((period) => (
          <button
            key={period}
            type="button"
            aria-pressed={billing === period}
            onClick={() => onBillingChange(period)}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm transition-colors ${
              billing === period
                ? "bg-accent font-semibold text-accent-ink"
                : "text-fg-muted hover:text-fg"
            }`}
          >
            {period === "monthly" ? "Monthly" : "Annual"}
            {period === "annual" && (
              <span
                className={`rounded-full px-1.5 py-0.5 font-mono text-[9.5px] tracking-wider ${
                  billing === "annual"
                    ? "bg-accent-ink/20 text-accent-ink"
                    : "bg-accent-quiet text-accent"
                }`}
              >
                save 17%
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatCard() {
  return (
    <div className="animate-fade-in-up delay-400 mb-10 grid items-center gap-6 rounded-xl border border-accent/25 bg-accent-quiet p-6 md:grid-cols-[auto_1fr] md:gap-7 md:p-7">
      <div className="font-mono text-5xl font-semibold tracking-tight text-accent md:text-[60px]">
        94%
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-base leading-snug font-medium text-fg md:text-[17px]">
          of AI-generated SQL fails at least one Atlas validator.
        </p>
        <p className="font-mono text-[11.5px] leading-relaxed tracking-wider text-fg-muted">
          Sample: thousands of queries across our beta cohort. Every tier ships the same
          7 gates — the difference is who runs the servers.
        </p>
      </div>
    </div>
  );
}

function TierCard({
  tier,
  billing,
}: {
  tier: Tier;
  billing: BillingPeriod;
}) {
  const { price, suffix, annualTotal } = formatPrice(tier.monthlyPrice, billing);

  let ctaStyle: string;
  if (tier.highlighted) {
    ctaStyle = "bg-accent text-accent-ink hover:bg-accent-hover";
  } else if (tier.monthlyPrice === null) {
    ctaStyle = "bg-fg text-bg hover:bg-accent";
  } else {
    ctaStyle = "border border-border-strong text-fg-muted hover:bg-bg-sunken hover:text-fg";
  }

  return (
    <div
      className={`relative flex flex-col rounded-2xl p-6 md:p-7 ${
        tier.highlighted
          ? "cloud-glow bg-bg-raised"
          : "border border-border bg-bg-raised"
      }`}
    >
      <div className="mb-2 font-mono text-[11px] tracking-wider text-fg-muted uppercase">
        // {tier.kind}
      </div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-2xl font-semibold tracking-tight text-fg">
          {tier.name}
        </h2>
        {tier.highlighted && (
          <span className="rounded-full border border-accent/60 px-2 py-0.5 font-mono text-[9.5px] tracking-wider text-accent uppercase">
            recommended
          </span>
        )}
      </div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[44px] leading-none font-semibold tracking-tight text-fg">
          {price}
        </span>
        <span className="text-xs text-fg-muted">{suffix}</span>
      </div>
      {annualTotal && (
        <p className="mb-3 font-mono text-[11px] tracking-wider text-fg-muted">
          {annualTotal}
        </p>
      )}
      <p className="mb-5 text-sm leading-relaxed text-fg-muted">{tier.tagline}</p>
      <ul className="mb-6 space-y-2.5">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5">
            <CheckIcon />
            <span className="text-sm text-fg-muted">{feature}</span>
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
        {tier.kind === "enterprise" ? (
          // Business tier — secondary affordance opens the talk-to-sales
          // dialog inline (no mailto link). The dialog's own trigger
          // renders the {tier.ctaSecondary} label so this row stays a
          // single click target with the same visual weight as the other
          // tiers' helper text.
          <div className="mt-2.5 flex justify-center">
            <TalkToSalesDialog
              triggerLabel={tier.ctaSecondary}
              initialPlanInterest="Business"
            />
          </div>
        ) : (
          <p className="mt-2.5 text-center font-mono text-[10.5px] tracking-wider text-fg-muted">
            {tier.ctaSecondary}
          </p>
        )}
      </div>
    </div>
  );
}

function ComparisonCell({ value }: { value: CellValue }) {
  if (typeof value === "string") {
    return <span className="font-mono text-xs text-fg-muted">{value}</span>;
  }
  return value ? <CheckIcon /> : <DashIcon />;
}

function FAQCard({ faq }: { faq: FAQ }) {
  return (
    <div className="rounded-xl border border-border bg-bg-raised p-5 md:p-6">
      <h3 className="mb-2 text-[15px] font-semibold text-fg">{faq.question}</h3>
      <p className="text-sm leading-relaxed text-fg-muted">{faq.answer}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function PricingContent() {
  const [billing, setBilling] = useState<BillingPeriod>("annual");

  return (
    <>
      {/* Toggle + stat card + tier cards */}
      <section className="mx-auto max-w-6xl px-6 pb-16 md:pb-24">
        <BillingToggle billing={billing} onBillingChange={setBilling} />

        <StatCard />

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {TIERS.map((tier) => (
            <TierCard key={tier.name} tier={tier} billing={billing} />
          ))}
        </div>
      </section>

      {/* Feature comparison */}
      <section
        aria-labelledby="compare-plans-heading"
        className="mx-auto max-w-6xl px-6 py-16 md:py-24"
      >
        <p className="mb-3 font-mono text-xs tracking-widest text-accent uppercase">
          // detailed comparison
        </p>
        <h2
          id="compare-plans-heading"
          className="mb-10 text-2xl font-semibold tracking-tight text-fg md:text-3xl"
        >
          What you get at every tier.
        </h2>

        <div className="hidden overflow-hidden rounded-xl border border-border lg:block">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-bg-sunken">
                <th
                  scope="col"
                  className="px-5 py-4 text-left font-mono text-[11px] tracking-widest text-fg-muted uppercase"
                >
                  feature
                </th>
                <th
                  scope="col"
                  className="px-5 py-4 text-center font-mono text-[11px] tracking-widest text-fg uppercase"
                >
                  Self-Hosted
                </th>
                <th
                  scope="col"
                  className="px-5 py-4 text-center font-mono text-[11px] tracking-widest text-fg uppercase"
                >
                  Starter
                </th>
                <th
                  scope="col"
                  className="bg-accent-quiet px-5 py-4 text-center font-mono text-[11px] tracking-widest text-accent uppercase"
                >
                  Pro
                </th>
                <th
                  scope="col"
                  className="px-5 py-4 text-center font-mono text-[11px] tracking-widest text-fg uppercase"
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
              className={`overflow-hidden rounded-xl border bg-bg-raised ${
                tierKey === "pro" ? "border-accent/40" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3">
                <h3 className="font-mono text-sm font-medium text-fg">
                  {TIER_LABELS[tierKey]}
                </h3>
                {tierKey === "pro" && (
                  <span className="rounded-full border border-accent/60 px-2 py-0.5 font-mono text-[9.5px] tracking-wider text-accent uppercase">
                    recommended
                  </span>
                )}
              </div>
              <div className="px-5 pb-2">
                {COMPARISON_SECTIONS.map((section) => (
                  <div key={section.label}>
                    <p className="mt-3 mb-1 font-mono text-[10.5px] tracking-widest text-accent uppercase">
                      // {section.label}
                    </p>
                    <div className="divide-y divide-border-soft">
                      {section.rows.map((row) => (
                        <div key={row.feature} className="flex items-center justify-between py-2.5">
                          <span className="text-sm text-fg-muted">{row.feature}</span>
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
        <p className="mb-3 font-mono text-xs tracking-widest text-accent uppercase">
          // frequently asked
        </p>
        <h2
          id="pricing-faq-heading"
          className="mb-8 text-2xl font-semibold tracking-tight text-fg md:text-3xl"
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
          className={`bg-bg-sunken px-5 pt-5 pb-2 text-left font-mono text-[10.5px] tracking-widest text-accent uppercase ${
            isFirst ? "" : "border-t border-border-soft"
          }`}
        >
          // {section.label}
        </th>
      </tr>
      {section.rows.map((row) => (
        <tr key={row.feature} className="border-b border-border-soft last:border-0">
          <td className="px-5 py-3 text-sm text-fg">{row.feature}</td>
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
          <td className="bg-accent-quiet px-5 py-3 text-center">
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
