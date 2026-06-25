/**
 * Onboarding email HTML templates.
 *
 * Inline-styled HTML suitable for email clients (no external CSS).
 * Templates respect workspace branding (logo, colors) when available.
 */

import type { OnboardingEmailStep } from "@useatlas/types";
import type { WorkspaceBrandingPublic } from "@useatlas/types";
import { ONBOARDING_SEQUENCE } from "./sequence";
import { getTrialStepDef, type TrialEmailStep } from "./trial-sequence";
import { getDunningStepDef, type DunningEmailStep } from "./dunning-sequence";

// ── Branding defaults ───────────────────────────────────────────────

const DEFAULT_APP_NAME = "Atlas";
const DEFAULT_PRIMARY_COLOR = "#171717"; // neutral-900
const DEFAULT_ACCENT_COLOR = "#2563eb"; // blue-600

interface BrandingContext {
  appName: string;
  primaryColor: string;
  accentColor: string;
  logoUrl: string | null;
  logoText: string | null;
}

function buildBrandingContext(branding?: WorkspaceBrandingPublic | null): BrandingContext {
  return {
    appName: branding?.logoText || DEFAULT_APP_NAME,
    primaryColor: branding?.primaryColor || DEFAULT_PRIMARY_COLOR,
    accentColor: branding?.primaryColor || DEFAULT_ACCENT_COLOR,
    logoUrl: branding?.logoUrl ?? null,
    logoText: branding?.logoText ?? null,
  };
}

// ── Shared helpers ──────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function header(ctx: BrandingContext): string {
  const logo = ctx.logoUrl
    ? `<img src="${escapeHtml(ctx.logoUrl)}" alt="${escapeHtml(ctx.appName)}" style="height:32px;max-width:160px;object-fit:contain;" />`
    : `<span style="font-size:20px;font-weight:700;color:${ctx.primaryColor};">${escapeHtml(ctx.appName)}</span>`;

  return `
    <div style="padding:24px 32px;border-bottom:2px solid ${ctx.accentColor};">
      ${logo}
    </div>`;
}

function footer(ctx: BrandingContext, unsubscribeUrl: string): string {
  return `
    <div style="padding:20px 32px;border-top:1px solid #e5e5e5;color:#737373;font-size:12px;line-height:1.5;">
      <p style="margin:0;">You're receiving this because you signed up for ${escapeHtml(ctx.appName)}.</p>
      <p style="margin:4px 0 0;">
        <a href="${escapeHtml(unsubscribeUrl)}" style="color:#737373;text-decoration:underline;">Unsubscribe</a>
        from onboarding emails.
      </p>
    </div>`;
}

function button(text: string, url: string, color: string): string {
  return `
    <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 28px;background:${color};color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
      ${escapeHtml(text)}
    </a>`;
}

function wrap(ctx: BrandingContext, content: string, unsubscribeUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e5e5;">
    ${header(ctx)}
    <div style="padding:32px;">
      ${content}
    </div>
    ${footer(ctx, unsubscribeUrl)}
  </div>
</body>
</html>`;
}

// ── Step content ────────────────────────────────────────────────────

function welcomeContent(ctx: BrandingContext, baseUrl: string): string {
  return `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">Welcome to ${escapeHtml(ctx.appName)}!</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      You're all set. ${escapeHtml(ctx.appName)} turns natural language into SQL — ask questions about your data and get instant answers.
    </p>
    <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:${ctx.primaryColor};">Quick-start guide:</p>
    <ol style="margin:0 0 24px;padding-left:20px;font-size:14px;color:#404040;line-height:1.8;">
      <li>Connect your database (PostgreSQL or MySQL)</li>
      <li>Atlas profiles your schema and builds a semantic layer</li>
      <li>Ask questions in natural language — Atlas writes the SQL</li>
      <li>Invite your team to collaborate</li>
    </ol>
    <div style="text-align:center;margin:24px 0;">
      ${button("Get Started", `${baseUrl}/admin/connections`, ctx.accentColor)}
    </div>`;
}

function connectDatabaseContent(ctx: BrandingContext, baseUrl: string): string {
  return `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">Connect your database</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      ${escapeHtml(ctx.appName)} needs a database connection to answer your questions. We support PostgreSQL and MySQL — read-only access is all that's needed.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
      Your connection is encrypted at rest and all queries are validated as read-only SELECT statements before execution.
    </p>
    <div style="text-align:center;margin:24px 0;">
      ${button("Connect Database", `${baseUrl}/admin/connections`, ctx.accentColor)}
    </div>`;
}

function firstQueryContent(ctx: BrandingContext, baseUrl: string, demoMode: boolean): string {
  // A demo-only signup activated the bundled demo, not their own production DB
  // (#3962). Asserting "your database is connected" to them is the same
  // demo-blindness #3949 fixed for connect_database, one step further down the
  // drip — so the demo variant points at the loaded demo dataset instead.
  const lede = demoMode
    ? `Your demo dataset is loaded — try asking a question in plain English. ${escapeHtml(ctx.appName)} will translate it to SQL and return the results.`
    : `Your database is connected — now try asking a question in plain English. ${escapeHtml(ctx.appName)} will translate it to SQL and return the results.`;
  return `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">Ask your first question</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      ${lede}
    </p>
    <p style="margin:0 0 8px;font-size:14px;font-weight:600;color:${ctx.primaryColor};">Try something like:</p>
    <ul style="margin:0 0 24px;padding-left:20px;font-size:14px;color:#404040;line-height:1.8;">
      <li>"How many active users do we have this month?"</li>
      <li>"Show me revenue by product category"</li>
      <li>"What are the top 10 customers by order count?"</li>
    </ul>
    <div style="text-align:center;margin:24px 0;">
      ${button("Ask a Question", baseUrl, ctx.accentColor)}
    </div>`;
}

// invite_team / explore_features audited for the #3962 BYO assumption: neither
// asserts "your database is connected" nor implies a connected production DB.
// "your data" reads as the loaded demo dataset for a demo-only signup, and the
// feature tour is datasource-agnostic — so both are demo-appropriate as-is and
// take no demoMode branch.
function inviteTeamContent(ctx: BrandingContext, baseUrl: string): string {
  return `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">Invite your team</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      ${escapeHtml(ctx.appName)} is better with your whole team. Invite colleagues so they can ask questions about your data too — no SQL knowledge required.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
      Team members get their own chat history and can share interesting queries with each other.
    </p>
    <div style="text-align:center;margin:24px 0;">
      ${button("Invite Team", `${baseUrl}/admin/users`, ctx.accentColor)}
    </div>`;
}

function exploreFeaturesContent(ctx: BrandingContext, baseUrl: string): string {
  return `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">Explore more features</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      You've got the basics down. Here's what else ${escapeHtml(ctx.appName)} can do:
    </p>
    <ul style="margin:0 0 24px;padding-left:20px;font-size:14px;color:#404040;line-height:1.8;">
      <li><strong>Notebooks</strong> — Save and organize multi-step analyses</li>
      <li><strong>Scheduled Reports</strong> — Get automatic email/Slack updates on metrics</li>
      <li><strong>Semantic Layer</strong> — Customize how your data is interpreted</li>
      <li><strong>Admin Console</strong> — Manage users, connections, and settings</li>
    </ul>
    <div style="text-align:center;margin:24px 0;">
      ${button("Explore Features", baseUrl, ctx.accentColor)}
    </div>`;
}

// All step renderers take `demoMode` for a uniform signature; only first_query
// branches on it today (#3962). The rest ignore the extra arg.
const STEP_CONTENT: Record<
  OnboardingEmailStep,
  (ctx: BrandingContext, baseUrl: string, demoMode: boolean) => string
> = {
  welcome: welcomeContent,
  connect_database: connectDatabaseContent,
  first_query: firstQueryContent,
  invite_team: inviteTeamContent,
  explore_features: exploreFeaturesContent,
};

// ── Public API ──────────────────────────────────────────────────────

export interface RenderedEmail {
  subject: string;
  html: string;
}

/**
 * Render an onboarding email for the given step.
 *
 * @param step - Which email in the sequence
 * @param baseUrl - The app base URL (e.g. https://app.useatlas.dev)
 * @param unsubscribeUrl - Full URL to unsubscribe endpoint
 * @param branding - Optional workspace branding to apply
 * @param opts.demoMode - The recipient activated the bundled demo rather than
 *   connecting their own database (#3962); selects demo-appropriate copy.
 */
export function renderOnboardingEmail(
  step: OnboardingEmailStep,
  baseUrl: string,
  unsubscribeUrl: string,
  branding?: WorkspaceBrandingPublic | null,
  opts?: { demoMode?: boolean },
): RenderedEmail {
  const ctx = buildBrandingContext(branding);
  const contentFn = STEP_CONTENT[step];
  const content = contentFn(ctx, baseUrl, opts?.demoMode ?? false);
  const html = wrap(ctx, content, unsubscribeUrl);

  // Resolve subject template
  const stepDef = ONBOARDING_SEQUENCE.find((s) => s.step === step);
  const subject = (stepDef?.subject ?? `${ctx.appName} — ${step}`).replace(
    /\{\{appName\}\}/g,
    ctx.appName,
  );

  return { subject, html };
}

// ── Invitation email ────────────────────────────────────────────────

function invitationFooter(ctx: BrandingContext): string {
  return `
    <div style="padding:20px 32px;border-top:1px solid #e5e5e5;color:#737373;font-size:12px;line-height:1.5;">
      <p style="margin:0;">You're receiving this because you were invited to ${escapeHtml(ctx.appName)}.</p>
      <p style="margin:4px 0 0;">If you weren't expecting this, you can safely ignore it.</p>
    </div>`;
}

function wrapInvitation(ctx: BrandingContext, content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e5e5;">
    ${header(ctx)}
    <div style="padding:32px;">
      ${content}
    </div>
    ${invitationFooter(ctx)}
  </div>
</body>
</html>`;
}

function invitationContent(
  ctx: BrandingContext,
  args: { orgName: string; inviterName: string; role: string; acceptUrl: string },
): string {
  return `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">You're invited to ${escapeHtml(args.orgName)}</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      ${escapeHtml(args.inviterName)} invited you to join <strong>${escapeHtml(args.orgName)}</strong> on ${escapeHtml(ctx.appName)} as <strong>${escapeHtml(args.role)}</strong>.
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#404040;line-height:1.6;">
      ${escapeHtml(ctx.appName)} turns natural language into SQL — ask questions about your data and get instant answers.
    </p>
    <div style="text-align:center;margin:24px 0;">
      ${button("Accept invitation", args.acceptUrl, ctx.accentColor)}
    </div>
    <p style="margin:16px 0 0;font-size:12px;color:#737373;line-height:1.6;">
      Or paste this link into your browser: <a href="${escapeHtml(args.acceptUrl)}" style="color:#737373;">${escapeHtml(args.acceptUrl)}</a>
    </p>`;
}

/**
 * Render the org invitation email triggered by Better Auth's
 * `sendInvitationEmail` callback (see `lib/auth/server.ts`). Standalone
 * from the onboarding-step renderer because invitations don't carry
 * an "unsubscribe from onboarding" footer — the recipient isn't an
 * Atlas user yet and has no onboarding preferences row.
 */
export function renderInvitationEmail(args: {
  orgName: string;
  inviterName: string;
  role: string;
  acceptUrl: string;
  branding?: WorkspaceBrandingPublic | null;
}): RenderedEmail {
  const ctx = buildBrandingContext(args.branding);
  const content = invitationContent(ctx, args);
  const html = wrapInvitation(ctx, content);
  const subject = `You've been invited to ${args.orgName} on ${ctx.appName}`;
  return { subject, html };
}

// ── Trial-expiry emails (#3434) ─────────────────────────────────────

/**
 * Billing-notice footer — trial-expiry emails are transactional account
 * communications (like invitations), NOT marketing drip, so they carry no
 * onboarding-unsubscribe link.
 */
function trialFooter(ctx: BrandingContext): string {
  return `
    <div style="padding:20px 32px;border-top:1px solid #e5e5e5;color:#737373;font-size:12px;line-height:1.5;">
      <p style="margin:0;">You're receiving this billing notice because you're an admin of a ${escapeHtml(ctx.appName)} workspace on a free trial.</p>
    </div>`;
}

function wrapTrial(ctx: BrandingContext, content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e5e5;">
    ${header(ctx)}
    <div style="padding:32px;">
      ${content}
    </div>
    ${trialFooter(ctx)}
  </div>
</body>
</html>`;
}

function trialEndingContent(
  ctx: BrandingContext,
  args: { daysLeft: number; endsAtLabel: string; upgradeUrl: string },
): string {
  const dayWord = args.daysLeft === 1 ? "day" : "days";
  const headline =
    args.daysLeft === 1
      ? "Your trial ends tomorrow"
      : `Your trial ends in ${args.daysLeft} ${dayWord}`;
  return `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">${headline}</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      Your ${escapeHtml(ctx.appName)} free trial ends on <strong>${escapeHtml(args.endsAtLabel)}</strong>.
      After that, chat and queries are paused for everyone in your workspace until a plan is chosen.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
      Pick a plan now and your team won't notice a thing — your connections, semantic layer, and conversation history all carry over.
    </p>
    <div style="text-align:center;margin:24px 0;">
      ${button("Choose a plan", args.upgradeUrl, ctx.accentColor)}
    </div>`;
}

function trialExpiredContent(
  ctx: BrandingContext,
  args: { endsAtLabel: string; upgradeUrl: string },
): string {
  return `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">Your trial has expired</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      Your ${escapeHtml(ctx.appName)} free trial ended on <strong>${escapeHtml(args.endsAtLabel)}</strong>.
      Chat and queries are paused for your workspace — nothing has been deleted.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
      Subscribe to a plan to pick up exactly where your team left off.
    </p>
    <div style="text-align:center;margin:24px 0;">
      ${button("Choose a plan", args.upgradeUrl, ctx.accentColor)}
    </div>`;
}

/**
 * Render a trial-expiry notice (T-3d / T-1d / expiry). The upgrade CTA
 * points at the self-serve plan picker on /admin/billing (#3418).
 *
 * @param step - Which trial notice to render.
 * @param args.trialEndsAt - The *effective* trial end (see
 *   `lib/billing/trial-expiry.ts`) — the same date enforcement uses.
 */
export function renderTrialExpiryEmail(
  step: TrialEmailStep,
  args: {
    baseUrl: string;
    trialEndsAt: Date;
    branding?: WorkspaceBrandingPublic | null;
  },
): RenderedEmail {
  const ctx = buildBrandingContext(args.branding);
  const upgradeUrl = `${args.baseUrl}/admin/billing`;
  const endsAtLabel = args.trialEndsAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  const content =
    step === "trial_expired"
      ? trialExpiredContent(ctx, { endsAtLabel, upgradeUrl })
      : trialEndingContent(ctx, {
          daysLeft: step === "trial_ending_1d" ? 1 : 3,
          endsAtLabel,
          upgradeUrl,
        });

  const stepDef = getTrialStepDef(step);
  const subject = (stepDef?.subject ?? `${ctx.appName} trial update`).replace(
    /\{\{appName\}\}/g,
    ctx.appName,
  );

  return { subject, html: wrapTrial(ctx, content) };
}

// ── Dunning (payment-failure) emails (#3424) ────────────────────────

/**
 * Billing-notice footer for dunning emails — transactional account
 * communications, NOT marketing drip, so no onboarding-unsubscribe link
 * (mirrors {@link trialFooter}).
 */
function dunningFooter(ctx: BrandingContext): string {
  return `
    <div style="padding:20px 32px;border-top:1px solid #e5e5e5;color:#737373;font-size:12px;line-height:1.5;">
      <p style="margin:0;">You're receiving this billing notice because you're an admin of a ${escapeHtml(ctx.appName)} workspace with a payment issue.</p>
    </div>`;
}

function wrapDunning(ctx: BrandingContext, content: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;">
  <div style="max-width:600px;margin:32px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e5e5;">
    ${header(ctx)}
    <div style="padding:32px;">
      ${content}
    </div>
    ${dunningFooter(ctx)}
  </div>
</body>
</html>`;
}

/** Static per-step copy. Each entry returns the inner HTML for the step. */
const DUNNING_CONTENT: Record<
  DunningEmailStep,
  (ctx: BrandingContext, billingUrl: string) => string
> = {
  dunning_past_due: (ctx, billingUrl) => `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">Your payment didn't go through</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      We couldn't process the latest payment for your ${escapeHtml(ctx.appName)} subscription. Your workspace is
      <strong>still fully active</strong> — but we'll keep retrying the charge, and access will be paused if it keeps failing.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
      Update your payment method now to avoid any interruption.
    </p>
    <div style="text-align:center;margin:24px 0;">
      ${button("Update payment method", billingUrl, ctx.accentColor)}
    </div>`,
  dunning_unpaid: (ctx, billingUrl) => `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">Your workspace is paused</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      Repeated payment attempts for your ${escapeHtml(ctx.appName)} subscription have failed, so chat and queries are
      <strong>paused for your workspace</strong>. Nothing has been deleted — your connections, semantic layer, and history are intact.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
      Update your payment method to restore access immediately.
    </p>
    <div style="text-align:center;margin:24px 0;">
      ${button("Update payment method", billingUrl, ctx.accentColor)}
    </div>`,
  dunning_suspended: (ctx, billingUrl) => `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">Final notice — workspace suspended</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      After several failed payment attempts, your ${escapeHtml(ctx.appName)} workspace has been
      <strong>suspended</strong>. This is the final notice before we stop retrying the charge. Your data is safe and nothing has been deleted.
    </p>
    <p style="margin:0 0 16px;font-size:14px;color:#404040;line-height:1.6;">
      Update your payment method to reactivate your workspace and pick up exactly where your team left off.
    </p>
    <div style="text-align:center;margin:24px 0;">
      ${button("Update payment method", billingUrl, ctx.accentColor)}
    </div>`,
  dunning_recovered: (ctx, billingUrl) => `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">You're all set — access restored</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      Thanks — your payment went through and your ${escapeHtml(ctx.appName)} workspace is
      <strong>fully active again</strong>. Chat and queries are back on for everyone.
    </p>
    <div style="text-align:center;margin:24px 0;">
      ${button("Open billing", billingUrl, ctx.accentColor)}
    </div>`,
};

/**
 * Render a dunning (payment-failure) notice. The CTA points at the
 * self-serve billing page (`/admin/billing`), where the customer can open
 * the Stripe Customer Portal and update their card.
 *
 * @param step - Which rung of the dunning ladder to render.
 */
export function renderDunningEmail(
  step: DunningEmailStep,
  args: {
    baseUrl: string;
    branding?: WorkspaceBrandingPublic | null;
  },
): RenderedEmail {
  const ctx = buildBrandingContext(args.branding);
  const billingUrl = `${args.baseUrl}/admin/billing`;
  const content = DUNNING_CONTENT[step](ctx, billingUrl);

  const stepDef = getDunningStepDef(step);
  const subject = (stepDef?.subject ?? `${ctx.appName} billing notice`).replace(
    /\{\{appName\}\}/g,
    ctx.appName,
  );

  return { subject, html: wrapDunning(ctx, content) };
}
