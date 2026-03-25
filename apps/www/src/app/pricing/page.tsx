import type { Metadata } from "next";
import { type ReactNode } from "react";

export const metadata: Metadata = {
  title: "Pricing — Atlas",
  description:
    "Atlas pricing: 14-day free trial, Team, and Enterprise plans. Self-host for free or let us handle infrastructure with Atlas Cloud.",
  openGraph: {
    title: "Pricing — Atlas",
    description:
      "Atlas pricing: 14-day free trial, Team, and Enterprise plans. Self-host for free or use Atlas Cloud.",
    url: "https://useatlas.dev/pricing",
    siteName: "Atlas",
    type: "website",
  },
};

// ---------------------------------------------------------------------------
// Shared components (matching landing page patterns)
// ---------------------------------------------------------------------------

const GITHUB_PATH =
  "M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z";

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d={GITHUB_PATH} />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

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

function Divider() {
  return (
    <div className="mx-auto max-w-5xl px-6">
      <div className="h-px bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-4 font-mono text-xs tracking-widest text-brand/80 uppercase">
      {children}
    </p>
  );
}

function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className ?? "h-4 w-4 transition-transform group-hover:translate-x-0.5"}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Tier {
  name: string;
  price: string;
  priceSuffix?: string;
  description: string;
  cta: string;
  ctaHref: string;
  highlighted?: boolean;
  features: string[];
}

const TIERS: Tier[] = [
  {
    name: "Trial",
    price: "Free",
    priceSuffix: "14 days",
    description:
      "Full Team-tier access for 14 days. No credit card required. Connect your database and start asking questions today.",
    cta: "Start free trial",
    ctaHref: "https://app.useatlas.dev/signup",
    features: [
      "10,000 queries / month",
      "5M tokens / month",
      "Up to 25 members",
      "5 datasource connections",
      "All databases & plugins",
      "Admin console & API",
      "Community support",
    ],
  },
  {
    name: "Team",
    price: "$49",
    priceSuffix: "/ seat / month",
    description:
      "Everything in Trial, with no time limit. The plan for teams that query their data daily.",
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
      "Unlimited queries",
      "Unlimited tokens",
      "Unlimited members",
      "Unlimited connections",
      "SSO & SCIM provisioning",
      "Custom roles & approval workflows",
      "Audit retention & compliance reporting",
      "Data residency options",
      "SLA monitoring & backups",
      "Dedicated support & onboarding",
    ],
  },
];

interface ComparisonRow {
  feature: string;
  selfHosted: boolean | string;
  trial: boolean | string;
  team: boolean | string;
  enterprise: boolean | string;
}

const COMPARISON: ComparisonRow[] = [
  { feature: "Text-to-SQL agent", selfHosted: true, trial: true, team: true, enterprise: true },
  { feature: "Semantic layer", selfHosted: true, trial: true, team: true, enterprise: true },
  { feature: "All 7 databases", selfHosted: true, trial: true, team: true, enterprise: true },
  { feature: "20+ plugins", selfHosted: true, trial: true, team: true, enterprise: true },
  { feature: "Embeddable widget", selfHosted: true, trial: true, team: true, enterprise: true },
  { feature: "Admin console", selfHosted: true, trial: true, team: true, enterprise: true },
  { feature: "MCP server", selfHosted: true, trial: true, team: true, enterprise: true },
  { feature: "Dynamic learning", selfHosted: true, trial: true, team: true, enterprise: true },
  { feature: "Queries / month", selfHosted: "Unlimited", trial: "10,000", team: "10,000", enterprise: "Unlimited" },
  { feature: "Tokens / month", selfHosted: "Unlimited", trial: "5M", team: "5M", enterprise: "Unlimited" },
  { feature: "Team members", selfHosted: "Unlimited", trial: "25", team: "25", enterprise: "Unlimited" },
  { feature: "Datasource connections", selfHosted: "Unlimited", trial: "5", team: "5", enterprise: "Unlimited" },
  { feature: "BYOT (bring your own token)", selfHosted: false, trial: false, team: true, enterprise: true },
  { feature: "SSO & SCIM", selfHosted: false, trial: false, team: false, enterprise: true },
  { feature: "Custom roles", selfHosted: false, trial: false, team: false, enterprise: true },
  { feature: "Approval workflows", selfHosted: false, trial: false, team: false, enterprise: true },
  { feature: "Compliance reporting", selfHosted: false, trial: false, team: false, enterprise: true },
  { feature: "Data residency", selfHosted: false, trial: false, team: false, enterprise: true },
  { feature: "SLA & backups", selfHosted: false, trial: false, team: false, enterprise: true },
  { feature: "Support", selfHosted: "Community", trial: "Community", team: "Email", enterprise: "Dedicated" },
];

interface FAQ {
  question: string;
  answer: string;
}

const FAQS: FAQ[] = [
  {
    question: "Is there a free tier?",
    answer:
      "Self-hosted Atlas is free and always will be (AGPL-3.0). For Atlas Cloud, every workspace starts with a 14-day free trial with full Team-tier access — no credit card required.",
  },
  {
    question: "What is BYOT (bring your own token)?",
    answer:
      "BYOT lets you use your own LLM API keys (Anthropic, OpenAI, etc.) instead of our bundled tokens. This reduces your Atlas bill since you're paying the LLM provider directly. Available on Team and Enterprise plans.",
  },
  {
    question: "What happens when my trial ends?",
    answer:
      "Your workspace becomes read-only — you can still view past conversations and export data, but new queries are paused until you subscribe to a paid plan.",
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

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function TierCard({ tier }: { tier: Tier }) {
  const isEnterprise = tier.name === "Enterprise";
  return (
    <div
      className={`flex flex-col rounded-xl p-8 md:p-10 ${
        tier.highlighted
          ? "cloud-glow bg-zinc-900/50"
          : "border border-zinc-800/60 bg-zinc-900/30"
      }`}
    >
      <div className="mb-1 font-mono text-xs tracking-widest text-brand/80 uppercase">
        {tier.name}
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
          className={`group inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-all ${
            tier.highlighted
              ? "bg-brand text-zinc-950 hover:bg-brand-hover"
              : isEnterprise
                ? "border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
                : "bg-zinc-100 text-zinc-950 hover:bg-white"
          }`}
        >
          {tier.cta}
          <ArrowIcon />
        </a>
      </div>
    </div>
  );
}

function ComparisonCell({ value }: { value: boolean | string }) {
  if (typeof value === "string") {
    return <span className="text-sm text-zinc-400">{value}</span>;
  }
  return value ? <CheckIcon /> : <DashIcon />;
}

function FAQItem({ faq }: { faq: FAQ }) {
  return (
    <div className="border-b border-zinc-800/60 py-6 last:border-0">
      <h3 className="mb-2 text-sm font-medium text-zinc-100">{faq.question}</h3>
      <p className="text-sm leading-relaxed text-zinc-400">{faq.answer}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PricingPage() {
  return (
    <div className="relative min-h-screen">
      {/* Top gradient glow */}
      <div
        className="pointer-events-none absolute top-0 left-1/2 -z-10 h-[600px] w-[800px] -translate-x-1/2"
        style={{
          background:
            "radial-gradient(ellipse at center, color-mix(in oklch, var(--atlas-brand) 6%, transparent) 0%, transparent 70%)",
        }}
      />

      {/* Nav */}
      <nav className="animate-fade-in mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <a href="/" className="flex items-center gap-2.5">
          <svg viewBox="0 0 256 256" fill="none" className="h-6 w-6 text-brand" aria-hidden="true">
            <path d="M128 24 L232 208 L24 208 Z" stroke="currentColor" strokeWidth="14" fill="none" strokeLinejoin="round"/>
            <circle cx="128" cy="28" r="16" fill="currentColor"/>
          </svg>
          <span className="font-mono text-lg font-semibold tracking-tight text-zinc-100">
            atlas
          </span>
          <span className="rounded-full border border-brand/20 bg-brand/10 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-brand uppercase">
            beta
          </span>
        </a>
        <div className="flex items-center gap-4 sm:gap-6">
          <a
            href="/pricing"
            className="text-sm text-zinc-300 transition-colors hover:text-zinc-100"
          >
            Pricing
          </a>
          <a
            href="https://docs.useatlas.dev"
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
          >
            Docs
          </a>
          <a
            href="https://github.com/AtlasDevHQ/atlas"
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
          >
            GitHub
          </a>
          <a
            href="https://app.useatlas.dev"
            className="rounded-md bg-zinc-100 px-3.5 py-1.5 text-sm font-medium text-zinc-950 transition-colors hover:bg-white"
          >
            Sign up
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pt-16 pb-16 text-center md:pt-24 md:pb-20">
        <SectionLabel>Pricing</SectionLabel>
        <h1 className="animate-fade-in-up delay-100 text-3xl font-semibold tracking-tight text-zinc-100 md:text-5xl">
          Simple, transparent pricing
        </h1>
        <p className="animate-fade-in-up delay-200 mx-auto mt-4 max-w-xl text-lg text-zinc-400">
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
      <section className="mx-auto max-w-5xl px-6 pb-16">
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
                <th className="px-6 py-4 text-left text-sm font-medium text-zinc-300">Feature</th>
                <th className="px-6 py-4 text-center text-sm font-medium text-zinc-300">Self-Hosted</th>
                <th className="px-6 py-4 text-center text-sm font-medium text-zinc-300">Trial</th>
                <th className="px-6 py-4 text-center text-sm font-medium text-zinc-300">Team</th>
                <th className="px-6 py-4 text-center text-sm font-medium text-zinc-300">Enterprise</th>
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
                    <span className="inline-flex justify-center"><ComparisonCell value={row.trial} /></span>
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
          {(["selfHosted", "trial", "team", "enterprise"] as const).map((tierKey) => {
            const label = { selfHosted: "Self-Hosted", trial: "Trial", team: "Team", enterprise: "Enterprise" }[tierKey];
            return (
              <div key={tierKey} className="rounded-xl border border-zinc-800/60 bg-zinc-900/30">
                <div className="border-b border-zinc-800/60 px-5 py-3">
                  <h3 className="font-mono text-sm font-medium text-zinc-100">{label}</h3>
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
            );
          })}
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
        <div className="grid gap-0 md:grid-cols-2 md:gap-x-12">
          <div>
            {FAQS.slice(0, 4).map((faq) => (
              <FAQItem key={faq.question} faq={faq} />
            ))}
          </div>
          <div>
            {FAQS.slice(4).map((faq) => (
              <FAQItem key={faq.question} faq={faq} />
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="mx-auto max-w-5xl px-6 pb-12">
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-800 to-transparent" />
        <div className="flex flex-col items-center justify-between gap-4 pt-8 sm:flex-row">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 256 256" fill="none" className="h-4 w-4 text-brand/60" aria-hidden="true">
                <path d="M128 24 L232 208 L24 208 Z" stroke="currentColor" strokeWidth="14" fill="none" strokeLinejoin="round"/>
                <circle cx="128" cy="28" r="16" fill="currentColor"/>
              </svg>
              <span className="font-mono text-sm text-zinc-600">
                atlas
              </span>
            </div>
            <a
              href="https://github.com/AtlasDevHQ/atlas"
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800/60 px-2.5 py-1 text-[11px] font-medium text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-400"
            >
              <GitHubIcon className="h-3 w-3" />
              Open source
            </a>
          </div>
          <div className="flex items-center gap-6">
            <a
              href="https://docs.useatlas.dev"
              className="text-xs text-zinc-600 transition-colors hover:text-zinc-400"
            >
              Docs
            </a>
            <a
              href="https://app.useatlas.dev"
              className="text-xs text-zinc-600 transition-colors hover:text-zinc-400"
            >
              Atlas Cloud
            </a>
            <a
              href="https://github.com/AtlasDevHQ/atlas"
              className="text-xs text-zinc-600 transition-colors hover:text-zinc-400"
            >
              Built by @msywulak
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
