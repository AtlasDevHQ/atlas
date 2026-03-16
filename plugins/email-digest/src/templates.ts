/**
 * Email digest HTML template.
 *
 * Inline-styled HTML suitable for email clients (no external CSS).
 * Mirrors the format-email.ts style from the scheduler package.
 */

import type { MetricResult } from "./config";

const MAX_TABLE_ROWS = 25;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function trendIndicator(current: string | number | null, previous: string | number | null): string {
  if (current == null || previous == null) return "";
  const cur = typeof current === "string" ? parseFloat(current) : current;
  const prev = typeof previous === "string" ? parseFloat(previous) : previous;
  if (isNaN(cur) || isNaN(prev) || prev === 0) return "";

  const pctChange = ((cur - prev) / Math.abs(prev)) * 100;
  const arrow = pctChange > 0 ? "&#9650;" : pctChange < 0 ? "&#9660;" : "&#9654;";
  const color = pctChange > 0 ? "#22c55e" : pctChange < 0 ? "#ef4444" : "#6b7280";
  const sign = pctChange > 0 ? "+" : "";
  return ` <span style="color:${color};font-size:12px;">${arrow} ${sign}${pctChange.toFixed(1)}%</span>`;
}

function renderMetricSection(metric: MetricResult): string {
  if (metric.error) {
    return `
      <div style="padding:12px 24px;border-bottom:1px solid #e9ecef;">
        <h3 style="margin:0 0 8px;color:#495057;font-size:16px;">${escapeHtml(metric.name)}</h3>
        <p style="margin:0;color:#ef4444;font-size:14px;">Failed to retrieve: ${escapeHtml(metric.error)}</p>
      </div>
    `;
  }

  const sections: string[] = [];

  // Metric title + value
  const valueDisplay = metric.value != null ? String(metric.value) : "—";
  const trend = trendIndicator(metric.value, metric.previousValue ?? null);

  sections.push(`
    <div style="padding:12px 24px;border-bottom:1px solid #e9ecef;">
      <h3 style="margin:0 0 4px;color:#495057;font-size:16px;">${escapeHtml(metric.name)}</h3>
      <p style="margin:0;color:#212529;font-size:24px;font-weight:600;">${escapeHtml(valueDisplay)}${trend}</p>
    </div>
  `);

  // Data table (if provided)
  if (metric.columns?.length && metric.rows?.length) {
    const displayRows = metric.rows.slice(0, MAX_TABLE_ROWS);
    const truncated = metric.rows.length > MAX_TABLE_ROWS;

    const headerCells = metric.columns
      .map(
        (col) =>
          `<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #dee2e6;background:#f8f9fa;font-size:11px;color:#495057;">${escapeHtml(col)}</th>`,
      )
      .join("");

    const bodyRows = displayRows
      .map((row) => {
        const cells = metric.columns!
          .map(
            (col) =>
              `<td style="padding:4px 10px;border-bottom:1px solid #e9ecef;font-size:12px;color:#212529;">${escapeHtml(String(row[col] ?? ""))}</td>`,
          )
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");

    let tableHtml = `
      <div style="padding:4px 24px 12px;">
        <table style="border-collapse:collapse;width:100%;font-family:monospace;">
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
    `;
    if (truncated) {
      tableHtml += `<p style="margin:4px 0 0;color:#6c757d;font-size:11px;">Showing first ${MAX_TABLE_ROWS} of ${metric.rows.length} rows</p>`;
    }
    tableHtml += `</div>`;
    sections.push(tableHtml);
  }

  return sections.join("");
}

export interface DigestEmailContent {
  subject: string;
  html: string;
  text: string;
}

export function renderDigestEmail(
  metrics: MetricResult[],
  frequency: "daily" | "weekly",
  unsubscribeUrl: string,
  managementUrl: string,
): DigestEmailContent {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const periodLabel = frequency === "daily" ? "Daily" : "Weekly";
  const subject = `Atlas ${periodLabel} Digest — ${dateStr}`;

  // HTML version
  const metricSections = metrics.map(renderMetricSection).join("");

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#ffffff;">
  <div style="max-width:700px;margin:0 auto;border:1px solid #e9ecef;border-radius:8px;overflow:hidden;">
    <div style="background:#f8f9fa;padding:16px 24px;border-bottom:2px solid #e9ecef;">
      <h2 style="margin:0;color:#212529;font-size:20px;">Atlas ${periodLabel} Digest</h2>
      <p style="margin:4px 0 0;color:#6c757d;font-size:14px;">${escapeHtml(dateStr)} &middot; ${metrics.length} metric${metrics.length === 1 ? "" : "s"}</p>
    </div>
    ${metricSections}
    <div style="border-top:1px solid #e9ecef;padding:12px 24px;color:#adb5bd;font-size:12px;">
      <a href="${escapeHtml(managementUrl)}" style="color:#6c757d;text-decoration:underline;">Manage subscriptions</a>
      &middot;
      <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6c757d;text-decoration:underline;">Unsubscribe</a>
      &middot; Generated ${now.toISOString()}
    </div>
  </div>
</body>
</html>`;

  // Plain text fallback
  const textMetrics = metrics
    .map((m) => {
      if (m.error) return `[${m.name}] ERROR: ${m.error}`;
      return `[${m.name}] ${m.value ?? "—"}`;
    })
    .join("\n");

  const text = `Atlas ${periodLabel} Digest — ${dateStr}\n\n${textMetrics}\n\nManage subscriptions: ${managementUrl}\nUnsubscribe: ${unsubscribeUrl}`;

  return { subject, html, text };
}
