/**
 * Onboarding email HTML templates.
 *
 * Inline-styled HTML suitable for email clients (no external CSS).
 * Templates respect workspace branding (logo, colors) when available.
 */

import type { OnboardingEmailStep } from "@useatlas/types";
import type { WorkspaceBrandingPublic } from "@useatlas/types";
import { ONBOARDING_SEQUENCE } from "./sequence";

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

function firstQueryContent(ctx: BrandingContext, baseUrl: string): string {
  return `
    <h1 style="margin:0 0 16px;font-size:24px;color:${ctx.primaryColor};">Ask your first question</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#404040;line-height:1.6;">
      Your database is connected — now try asking a question in plain English. ${escapeHtml(ctx.appName)} will translate it to SQL and return the results.
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

const STEP_CONTENT: Record<OnboardingEmailStep, (ctx: BrandingContext, baseUrl: string) => string> = {
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
 */
export function renderOnboardingEmail(
  step: OnboardingEmailStep,
  baseUrl: string,
  unsubscribeUrl: string,
  branding?: WorkspaceBrandingPublic | null,
): RenderedEmail {
  const ctx = buildBrandingContext(branding);
  const contentFn = STEP_CONTENT[step];
  const content = contentFn(ctx, baseUrl);
  const html = wrap(ctx, content, unsubscribeUrl);

  // Resolve subject template
  const stepDef = ONBOARDING_SEQUENCE.find((s) => s.step === step);
  const subject = (stepDef?.subject ?? `${ctx.appName} — ${step}`).replace(
    /\{\{appName\}\}/g,
    ctx.appName,
  );

  return { subject, html };
}
