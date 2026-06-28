"use client";

import { useState } from "react";
import { ArrowIcon, CheckIcon } from "../../components/shared";
import { TalkToSalesDialog } from "../../components/talk-to-sales-dialog";
import {
  ENTITLEMENT_ROWS,
  ENTITLEMENT_SECTION_ORDER,
  TIER_MONTHLY_PRICE,
  type EntitlementRow,
  type EntitlementSection,
  type FeatureId,
  type PricingColumn,
} from "./entitlements.generated";

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

// The comparison columns are exactly the generated artifact's columns —
// alias `PricingColumn` rather than re-spell the union, so the page's column
// set is compile-time-tied to the SSOT-derived artifact and can't drift.
type TierKey = PricingColumn;
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

// Paid-tier base prices are read from TIER_MONTHLY_PRICE — the generated
// mirror of `plans.ts` `pricePerSeat` (Atlas's internal price SSOT) — never
// hand-coded, so an advertised base price can't drift from `plans.ts` (#4060).
// Self-Hosted is the free OSS tier and renders "Free forever", so it stays
// `null` rather than the mirror's $0.
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
    monthlyPrice: TIER_MONTHLY_PRICE.starter,
    tagline: "Solo + small teams.",
    badge: "14-day free trial",
    cta: "Start free trial",
    ctaHref: "https://app.useatlas.dev/signup?plan=starter",
    ctaSecondary: "no card · work email",
    features: [
      "$20/seat AI-usage credit, then at cost",
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
    monthlyPrice: TIER_MONTHLY_PRICE.pro,
    tagline: "Growing teams.",
    badge: "14-day free trial",
    cta: "Start free trial",
    ctaHref: "https://app.useatlas.dev/signup?plan=pro",
    ctaSecondary: "no card · work email",
    highlighted: true,
    features: [
      "$20/seat AI-usage credit, then at cost",
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
    monthlyPrice: TIER_MONTHLY_PRICE.business,
    tagline: "Regulated teams at scale.",
    badge: "14-day free trial",
    cta: "Start free trial",
    ctaHref: "https://app.useatlas.dev/signup?plan=business",
    ctaSecondary: "or talk to sales",
    features: [
      "$20/seat AI-usage credit, then at cost",
      "Unlimited seats & connections",
      "Default model: Sonnet 4.6",
      "BYOK for unlimited queries",
      "8 integrations: 6 chat + Linear + GitHub (Google Chat coming soon)",
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

// The `core` and `support` rows are quantitative limits and free-text copy,
// not gated per-tier feature entitlements — they stay hand-maintained here.
const CORE_SECTION: ComparisonSection = {
  label: "core",
  rows: [
    { feature: "Text-to-SQL agent", selfHosted: true, starter: true, pro: true, business: true },
    { feature: "Semantic layer", selfHosted: true, starter: true, pro: true, business: true },
    { feature: "All databases & plugins", selfHosted: true, starter: true, pro: true, business: true },
    { feature: "Notebooks & dashboards", selfHosted: true, starter: true, pro: true, business: true },
    { feature: "Admin console & API", selfHosted: true, starter: true, pro: true, business: true },
    { feature: "MCP server", selfHosted: true, starter: true, pro: true, business: true },
    { feature: "Included AI-usage credit", selfHosted: "Unlimited (BYOK)", starter: "$20/seat/mo", pro: "$20/seat/mo", business: "$20/seat/mo" },
    { feature: "Usage billing", selfHosted: "BYOK (you pay your provider)", starter: "At cost, no markup", pro: "At cost, no markup", business: "At cost, no markup" },
    { feature: "BYOK (unlimited queries)", selfHosted: "Default", starter: true, pro: true, business: true },
    { feature: "Default model", selfHosted: "Your choice", starter: "Haiku 4.5", pro: "Sonnet 4.6", business: "Sonnet 4.6" },
    { feature: "Seats", selfHosted: "Unlimited", starter: "Up to 10", pro: "Up to 25", business: "Unlimited" },
    { feature: "Database connections", selfHosted: "Unlimited", starter: "1", pro: "3", business: "Unlimited" },
    { feature: "Chat integrations", selfHosted: "Config-based", starter: "1 platform", pro: "3 platforms", business: "All 6 (Google Chat soon)" },
    { feature: "Past the included credit", selfHosted: "No limit (BYOK)", starter: "At cost, to spend cap", pro: "At cost, to spend cap", business: "At cost, to spend cap" },
  ],
};

const SUPPORT_SECTION: ComparisonSection = {
  label: "support",
  rows: [
    { feature: "Support channel", selfHosted: "Community", starter: "Email", pro: "Priority email", business: "Priority + Slack" },
  ],
};

// Hand-maintained rows prepended to a SSOT-derived section, ahead of the
// mirrored entitlement rows. "Custom domain" is a Pro+ marketing affordance,
// not one of the gated FeatureEntitlement capabilities, so it lives here at the
// top of the hosting section rather than in the SSOT. Keyed by section so a new
// section automatically renders (with no prefix) without touching this map.
const SECTION_PREFIX_ROWS: Partial<Record<EntitlementSection, ComparisonRow[]>> =
  {
    hosting: [
      { feature: "Custom domain", selfHosted: false, starter: false, pro: true, business: true },
    ],
  };

// Per-feature display overrides: a feature whose entitlement is a boolean in
// the SSOT but reads better as free text in one column (e.g. residency's
// "3 regions" for Business). Keyed by the artifact's `FeatureId` union — a
// misspelled key is a compile error, not a silent no-op — and the override
// applies only where the entitlement is already true, so it never widens what
// a tier unlocks beyond what the SSOT grants.
const CELL_LABEL_OVERRIDES: Partial<
  Record<FeatureId, Partial<Record<PricingColumn, string>>>
> = {
  residency: { business: "3 regions" },
};

/**
 * Build a comparison section from the SSOT-mirrored entitlement rows for a
 * given section, applying any free-text cell overrides. This is the WS4 link:
 * the per-tier ✓/– cells the page renders are derived from
 * `ENTITLEMENT_ROWS`, the drift-checked mirror of `FEATURE_ENTITLEMENTS`, so
 * they can't diverge from what the API actually enforces.
 */
function entitlementSection(label: EntitlementSection): ComparisonSection {
  const prefixRows = SECTION_PREFIX_ROWS[label] ?? [];
  const rows: ComparisonRow[] = ENTITLEMENT_ROWS.filter(
    (row) => row.section === label,
  ).map(toComparisonRow);
  return { label, rows: [...prefixRows, ...rows] };
}

function toComparisonRow(row: EntitlementRow): ComparisonRow {
  const overrides = CELL_LABEL_OVERRIDES[row.feature];
  const cellFor = (key: PricingColumn): CellValue => {
    const granted = row.cells[key];
    const override = overrides?.[key];
    // An override only ever decorates a granted cell — never flips a denied
    // one on — so the page can't claim a tier the SSOT doesn't grant.
    return granted && override !== undefined ? override : granted;
  };
  return {
    feature: row.label,
    selfHosted: cellFor("selfHosted"),
    starter: cellFor("starter"),
    pro: cellFor("pro"),
    business: cellFor("business"),
  };
}

// Iterate every SSOT section (in render order) rather than hand-listing them,
// so a section added to the SSOT can't be silently dropped from the page — it
// renders automatically. core/support are hand-maintained non-entitlement
// sections and bracket the SSOT-derived ones.
const COMPARISON_SECTIONS: ComparisonSection[] = [
  CORE_SECTION,
  ...ENTITLEMENT_SECTION_ORDER.map(entitlementSection),
  SUPPORT_SECTION,
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
      "Yes. Every plan lets you choose any supported model (Claude, GPT, etc.). AI usage is billed at provider cost with no markup, so switching to a more capable model simply draws down your included usage credit faster — and costs more per query once you're past it. Switch to BYOK to bill your own provider directly instead.",
  },
  {
    question: "What happens when I use up my included usage?",
    answer:
      "Every paid plan includes $20/seat per month of AI usage, billed at provider cost with zero markup and pooled across your seats. You'll get a warning as you approach it (from ~80%). Past the credit, you choose what happens: by default Atlas keeps serving at the same provider cost — your billing page shows \"in overage, $X.XX so far\" — bounded by a spend cap that backstops runaway usage; or set your workspace to cut off at the credit so nothing bills beyond it. There's no per-token markup and no flat lockout. Switch to BYOK at any time to bill your own provider directly.",
  },
  {
    question: "Is there a free option?",
    answer:
      "Yes — self-hosted Atlas is free and always will be (AGPL-3.0). Deploy on your own infrastructure with unlimited everything. For Atlas Cloud, all paid plans include a 14-day free trial with no credit card required (work email required — see below). Every trial runs at Starter-tier limits ($20/seat of included AI usage, up to 10 seats, 1 connection) for 14 days, regardless of the plan you start from.",
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
