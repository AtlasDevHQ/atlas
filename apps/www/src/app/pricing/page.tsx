import type { Metadata } from "next";

import { Footer } from "../../components/footer";
import { Nav } from "../../components/nav";
import { ArrowIcon, CheckIcon, Divider, GitHubIcon, SectionLabel, TopGlow } from "../../components/shared";
import { StickyNav } from "../../components/sticky-nav";

export const metadata: Metadata = {
  title: "Pricing — Atlas",
  description:
    "Atlas pricing: self-host for free, Team plan with 14-day trial, and Enterprise. Open-source under AGPL-3.0.",
  openGraph: {
    title: "Pricing — Atlas",
    description:
      "Atlas pricing: self-host for free, Team plan with 14-day trial, and Enterprise.",
    url: "https://useatlas.dev/pricing",
    siteName: "Atlas",
    type: "website",
  },
};

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Tier {
  name: string;
  price: string;
  priceSuffix?: string;
  badge?: string;
  description: string;
  cta: string;
  ctaHref: string;
  highlighted?: boolean;
  features: string[];
}

const TIERS: Tier[] = [
  {
    name: "Self-Hosted",
    price: "Free",
    priceSuffix: "forever",
    description:
      "Full-featured Atlas on your own infrastructure. Open-source under AGPL-3.0. No usage limits, no time limits.",
    cta: "Get started",
    ctaHref: "https://docs.useatlas.dev/getting-started",
    features: [
      "Unlimited queries & tokens",
      "Unlimited members",
      "Unlimited datasource connections",
      "All 7 databases & 21+ plugins",
      "Admin console & API",
      "MCP server",
      "Community support",
    ],
  },
  {
    name: "Team",
    price: "$49",
    priceSuffix: "/ seat / month",
    badge: "14-day free trial",
    description:
      "We handle infrastructure, security, and scaling. Start with a free trial — no credit card required.",
    cta: "Start free trial",
    ctaHref: "https://app.useatlas.dev/signup",
    highlighted: true,
    features: [
      "10,000 queries / month",
      "5M tokens / month",
      "Up to 25 members",
      "5 datasource connections",
      "All databases & plugins",
      "Admin console & API",
      "99.9% uptime SLA",
      "BYOT support",
      "Email support",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    description:
      "Unlimited everything, enterprise security, and dedicated support. Built for regulated industries and large teams.",
    cta: "Contact sales",
    ctaHref: "mailto:sales@useatlas.dev",
    features: [
      "Unlimited queries & tokens",
      "Unlimited members & connections",
      "SSO & SCIM provisioning",
      "Custom roles & approval workflows",
      "Audit retention & compliance reporting",
      "Data residency options",
      "99.95% uptime SLA",
      "Priority support & onboarding",
    ],
  },
];

type CellValue = boolean | string;

interface ComparisonRow {
  feature: string;
  selfHosted: CellValue;
  team: CellValue;
  enterprise: CellValue;
}

// BYOT "selfHosted: false" note: self-hosted users always provide their own LLM
// keys, but BYOT in the Cloud billing context means using your own keys to reduce
// your Atlas bill. The feature toggle and billing optimization are Cloud-only.
const COMPARISON: ComparisonRow[] = [
  { feature: "Text-to-SQL agent", selfHosted: true, team: true, enterprise: true },
  { feature: "Semantic layer", selfHosted: true, team: true, enterprise: true },
  { feature: "All 7 databases", selfHosted: true, team: true, enterprise: true },
  { feature: "21+ plugins", selfHosted: true, team: true, enterprise: true },
  { feature: "Embeddable widget", selfHosted: true, team: true, enterprise: true },
  { feature: "Admin console", selfHosted: true, team: true, enterprise: true },
  { feature: "MCP server", selfHosted: true, team: true, enterprise: true },
  { feature: "Dynamic learning", selfHosted: true, team: true, enterprise: true },
  { feature: "Queries / month", selfHosted: "Unlimited", team: "10,000", enterprise: "Unlimited" },
  { feature: "Tokens / month", selfHosted: "Unlimited", team: "5M", enterprise: "Unlimited" },
  { feature: "Team members", selfHosted: "Unlimited", team: "25", enterprise: "Unlimited" },
  { feature: "Datasource connections", selfHosted: "Unlimited", team: "5", enterprise: "Unlimited" },
  { feature: "BYOT (bring your own token)", selfHosted: false, team: true, enterprise: true },
  { feature: "SSO & SCIM", selfHosted: false, team: false, enterprise: true },
  { feature: "Custom roles", selfHosted: false, team: false, enterprise: true },
  { feature: "Approval workflows", selfHosted: false, team: false, enterprise: true },
  { feature: "Compliance reporting", selfHosted: false, team: false, enterprise: true },
  { feature: "Data residency", selfHosted: false, team: false, enterprise: true },
  { feature: "Uptime SLA", selfHosted: false, team: "99.9%", enterprise: "99.95%" },
  { feature: "Support", selfHosted: "Community", team: "Email", enterprise: "Priority" },
];

interface FAQ {
  question: string;
  answer: string;
}

const FAQS: FAQ[] = [
  {
    question: "Is there a free option?",
    answer:
      "Yes — self-hosted Atlas is free and always will be (AGPL-3.0). Deploy on your own infrastructure with unlimited everything. For Atlas Cloud, the Team plan includes a 14-day free trial with no credit card required.",
  },
  {
    question: "What is BYOT (bring your own token)?",
    answer:
      "BYOT lets you use your own LLM API keys (Anthropic, OpenAI, etc.) instead of our bundled tokens. This reduces your Atlas bill since you're paying the LLM provider directly. Available on Team and Enterprise plans.",
  },
  {
    question: "What happens when my trial ends?",
    answer:
      "Your workspace becomes read-only — you can still view past conversations and export data, but new queries are paused until you subscribe to the Team plan.",
  },
  {
    question: "Can I change plans later?",
    answer:
      "Yes. Upgrade or downgrade anytime from the billing page in your admin console. Changes take effect at the start of your next billing cycle. Enterprise downgrades require contacting support.",
  },
  {
    question: "How do overages work?",
    answer:
      "We don't surprise you with overage charges. When you approach your plan limits, you'll get warnings in the dashboard. If you hit a limit, queries are paused until the next billing cycle or you upgrade.",
  },
  {
    question: "Do you offer annual pricing?",
    answer:
      "Yes. Annual billing saves 20% on the Team plan. Contact us for Enterprise annual pricing.",
  },
  {
    question: "What payment methods do you accept?",
    answer:
      "We use Stripe for billing. All major credit cards, ACH, and SEPA direct debit are supported. Enterprise customers can also pay by invoice.",
  },
  {
    question: "Can I self-host and still get support?",
    answer:
      "Self-hosted Atlas includes community support via GitHub Discussions. If you need priority support, SLAs, or enterprise features while self-hosting, contact us about an Enterprise license.",
  },
];

const TIER_LABELS: Record<string, string> = {
  selfHosted: "Self-Hosted",
  team: "Team",
  enterprise: "Enterprise",
};

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

function TierCard({ tier }: { tier: Tier }) {
  let ctaStyle: string;
  if (tier.highlighted) {
    ctaStyle = "bg-brand text-zinc-950 hover:bg-brand-hover";
  } else if (tier.name === "Enterprise") {
    ctaStyle = "border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100";
  } else {
    ctaStyle = "bg-zinc-100 text-zinc-950 hover:bg-white";
  }

  return (
    <div
      className={`animate-fade-in-up delay-300 flex flex-col rounded-xl p-8 md:p-10 ${
        tier.highlighted
          ? "cloud-glow bg-zinc-900/50"
          : "border border-zinc-800/60 bg-zinc-900/30"
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-xs tracking-widest text-brand/80 uppercase">
          {tier.name}
        </span>
        {tier.badge && (
          <span className="rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-brand uppercase">
            {tier.badge}
          </span>
        )}
      </div>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-3xl font-semibold tracking-tight text-zinc-100">
          {tier.price}
        </span>
        {tier.priceSuffix && (
          <span className="text-sm text-zinc-500">{tier.priceSuffix}</span>
        )}
      </div>
      <p className="mb-6 text-sm leading-relaxed text-zinc-400">
        {tier.description}
      </p>
      <ul className="mb-8 space-y-3">
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
// Page
// ---------------------------------------------------------------------------

export default function PricingPage() {
  const faqHalf = Math.ceil(FAQS.length / 2);

  return (
    <div className="relative min-h-screen">
      <StickyNav />
      <TopGlow />
      <Nav currentPage="/pricing" />

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pt-16 pb-20 text-center md:pt-24 md:pb-28">
        <div className="animate-fade-in-up delay-100">
          <SectionLabel>Pricing</SectionLabel>
        </div>
        <h1 className="animate-fade-in-up delay-200 text-3xl font-semibold tracking-tight text-zinc-100 md:text-5xl">
          Simple, transparent pricing
        </h1>
        <p className="animate-fade-in-up delay-300 mx-auto mt-4 max-w-xl text-lg text-zinc-400">
          Self-host for free. Or start a 14-day trial on Atlas Cloud —
          no credit card required.
        </p>
      </section>

      {/* Tier cards */}
      <section className="mx-auto max-w-5xl px-6 pb-20 md:pb-28">
        <div className="grid gap-6 md:grid-cols-3">
          {TIERS.map((tier) => (
            <TierCard key={tier.name} tier={tier} />
          ))}
        </div>
      </section>

      {/* BYOT callout */}
      <section className="mx-auto max-w-5xl px-6 pb-20 md:pb-28">
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 p-8 md:flex md:items-center md:gap-8 md:p-10">
          <div className="mb-6 flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-zinc-800 text-brand md:mb-0">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
            </svg>
          </div>
          <div>
            <h3 className="mb-2 text-base font-semibold text-zinc-100">
              Bring your own token (BYOT)
            </h3>
            <p className="text-sm leading-relaxed text-zinc-400">
              Use your own Anthropic, OpenAI, or other LLM API keys instead of our bundled tokens.
              You pay the LLM provider directly at their rates — your Atlas bill only covers
              infrastructure. Available on Team and Enterprise plans.
            </p>
          </div>
        </div>
      </section>

      <Divider />

      {/* Feature comparison table */}
      <section className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        <SectionLabel>Compare plans</SectionLabel>
        <h2 className="mb-10 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
          Feature comparison
        </h2>

        {/* Desktop table */}
        <div className="hidden overflow-hidden rounded-xl border border-zinc-800/60 md:block">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800/60 bg-zinc-900/50">
                <th scope="col" className="px-6 py-4 text-left text-sm font-medium text-zinc-300">Feature</th>
                <th scope="col" className="px-6 py-4 text-center text-sm font-medium text-zinc-300">Self-Hosted</th>
                <th scope="col" className="px-6 py-4 text-center text-sm font-medium text-zinc-300">Team</th>
                <th scope="col" className="px-6 py-4 text-center text-sm font-medium text-zinc-300">Enterprise</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.feature} className="border-b border-zinc-800/40 last:border-0">
                  <td className="px-6 py-3.5 text-sm text-zinc-400">{row.feature}</td>
                  <td className="px-6 py-3.5 text-center">
                    <span className="inline-flex justify-center"><ComparisonCell value={row.selfHosted} /></span>
                  </td>
                  <td className="px-6 py-3.5 text-center">
                    <span className="inline-flex justify-center"><ComparisonCell value={row.team} /></span>
                  </td>
                  <td className="px-6 py-3.5 text-center">
                    <span className="inline-flex justify-center"><ComparisonCell value={row.enterprise} /></span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile comparison (stacked cards) */}
        <div className="space-y-6 md:hidden">
          {(["selfHosted", "team", "enterprise"] as const).map((tierKey) => (
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

      {/* Self-hosted callout */}
      <section className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        <div className="text-center">
          <SectionLabel>Open source</SectionLabel>
          <h2 className="mb-4 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
            Want full control? Self-host for free.
          </h2>
          <p className="mx-auto mb-8 max-w-xl text-zinc-400">
            Atlas is open-source under AGPL-3.0. Deploy on your own infrastructure with
            Docker, Railway, or Vercel. All core features, all databases, all plugins —
            no usage limits, no time limits.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <a
              href="https://docs.useatlas.dev/getting-started"
              className="group inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-950 transition-all hover:bg-white"
            >
              Read the docs
              <ArrowIcon />
            </a>
            <a
              href="https://github.com/AtlasDevHQ/atlas"
              className="group inline-flex items-center gap-2 rounded-lg border border-zinc-800 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-all hover:border-zinc-700 hover:text-zinc-100"
            >
              <GitHubIcon className="h-4 w-4" />
              View on GitHub
            </a>
          </div>
        </div>
      </section>

      <Divider />

      {/* FAQ */}
      <section className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        <SectionLabel>FAQ</SectionLabel>
        <h2 className="mb-8 text-2xl font-semibold tracking-tight text-zinc-100 md:text-3xl">
          Common questions
        </h2>
        {/* Split into two balanced columns */}
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

      <Footer />
    </div>
  );
}
