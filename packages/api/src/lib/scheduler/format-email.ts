/**
 * Email formatter for scheduled task results.
 *
 * Produces inline-styled HTML suitable for email clients (no external CSS).
 */

import type { ScheduledTask } from "@atlas/api/lib/scheduled-tasks";
import type { AgentQueryResult } from "@atlas/api/lib/agent-query";

const MAX_DATA_ROWS = 50;

export function formatEmailReport(
  task: ScheduledTask,
  result: AgentQueryResult,
): { subject: string; body: string } {
  const subject = `Atlas Report: ${task.name}`;

  const sections: string[] = [];

  // Header
  sections.push(`
    <div style="background:#f8f9fa;padding:16px 24px;border-bottom:2px solid #e9ecef;">
      <h2 style="margin:0;color:#212529;font-size:20px;">${escapeHtml(task.name)}</h2>
      <p style="margin:4px 0 0;color:#6c757d;font-size:14px;">Question: ${escapeHtml(task.question)}</p>
    </div>
  `);

  // Answer
  const answer = result.answer || "No answer generated.";
  sections.push(`
    <div style="padding:16px 24px;">
      <h3 style="margin:0 0 8px;color:#495057;font-size:16px;">Answer</h3>
      <p style="margin:0;color:#212529;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(answer)}</p>
    </div>
  `);

  // Data tables
  for (const dataset of result.data) {
    if (!dataset.columns.length || !dataset.rows.length) continue;

    const displayRows = dataset.rows.slice(0, MAX_DATA_ROWS);
    const truncated = dataset.rows.length > MAX_DATA_ROWS;

    const headerCells = dataset.columns
      .map((col) => `<th style="padding:8px 12px;text-align:left;border-bottom:2px solid #dee2e6;background:#f8f9fa;font-size:12px;color:#495057;">${escapeHtml(col)}</th>`)
      .join("");

    const bodyRows = displayRows
      .map((row) => {
        const cells = dataset.columns
          .map((col) => `<td style="padding:6px 12px;border-bottom:1px solid #e9ecef;font-size:13px;color:#212529;">${escapeHtml(String(row[col] ?? ""))}</td>`)
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");

    let tableHtml = `
      <div style="padding:0 24px 16px;">
        <table style="border-collapse:collapse;width:100%;font-family:monospace;">
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
    `;
    if (truncated) {
      tableHtml += `<p style="margin:4px 0 0;color:#6c757d;font-size:12px;">Showing first ${MAX_DATA_ROWS} of ${dataset.rows.length} rows</p>`;
    }
    tableHtml += `</div>`;
    sections.push(tableHtml);
  }

  // SQL
  if (result.sql.length > 0) {
    const sqlText = result.sql.join("\n\n");
    sections.push(`
      <div style="padding:0 24px 16px;">
        <h3 style="margin:0 0 8px;color:#495057;font-size:14px;">SQL</h3>
        <pre style="background:#f1f3f5;padding:12px;border-radius:4px;overflow-x:auto;font-size:12px;color:#495057;margin:0;">${escapeHtml(sqlText)}</pre>
      </div>
    `);
  }

  // Footer
  sections.push(`
    <div style="border-top:1px solid #e9ecef;padding:12px 24px;color:#adb5bd;font-size:12px;">
      ${result.steps} steps &middot; ${result.usage.totalTokens.toLocaleString()} tokens &middot; ${new Date().toISOString()}
    </div>
  `);

  const body = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#ffffff;">
      <div style="max-width:700px;margin:0 auto;border:1px solid #e9ecef;border-radius:8px;overflow:hidden;">
        ${sections.join("")}
      </div>
    </body>
    </html>
  `;

  return { subject, body };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
