/**
 * Cron expression helpers for the scheduled task form.
 *
 * Handles preset mapping, human-readable descriptions, and next-run-time computation
 * for standard 5-field cron expressions (minute hour day-of-month month day-of-week).
 */

// ── Presets ──────────────────────────────────────────────────────────

export interface CronPreset {
  label: string;
  value: string;
  cron: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { label: "Every hour", value: "hourly", cron: "0 * * * *" },
  { label: "Every day at 9 AM", value: "daily-9am", cron: "0 9 * * *" },
  { label: "Every weekday at 9 AM", value: "weekday-9am", cron: "0 9 * * 1-5" },
  { label: "Every Monday at 9 AM", value: "monday-9am", cron: "0 9 * * 1" },
  { label: "Custom", value: "custom", cron: "" },
];

export function presetFromCron(cron: string): string {
  const match = CRON_PRESETS.find((p) => p.cron === cron);
  return match?.value ?? "custom";
}

// ── Human-readable description ───────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatTime(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h}:${pad(minute)} ${ampm} UTC`;
}

export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "Invalid cron expression";

  const [minField, hourField, domField, monField, dowField] = parts;

  // Every minute
  if (minField === "*" && hourField === "*" && domField === "*" && monField === "*" && dowField === "*") {
    return "Every minute";
  }

  const minute = minField === "*" ? null : parseInt(minField, 10);
  const hour = hourField === "*" ? null : parseInt(hourField, 10);

  if (Number.isNaN(minute ?? 0) || Number.isNaN(hour ?? 0)) {
    return "Custom schedule";
  }

  const timeStr = hour !== null && minute !== null ? `at ${formatTime(hour, minute)}` : "";

  // Every N minutes (*/N)
  if (minField.startsWith("*/") && hourField === "*" && domField === "*" && monField === "*" && dowField === "*") {
    const n = parseInt(minField.slice(2), 10);
    return `Every ${n} minute${n !== 1 ? "s" : ""}`;
  }

  // Every hour at :MM
  if (minute !== null && hourField === "*" && domField === "*" && monField === "*" && dowField === "*") {
    return minute === 0 ? "Every hour" : `Every hour at :${pad(minute)}`;
  }

  // Specific day of week
  if (minute !== null && hour !== null && domField === "*" && monField === "*" && dowField !== "*") {
    if (dowField === "1-5") return `Every weekday ${timeStr}`;
    if (dowField === "0-6" || dowField === "*") return `Every day ${timeStr}`;
    const dayNum = parseInt(dowField, 10);
    if (!Number.isNaN(dayNum) && dayNum >= 0 && dayNum <= 6) {
      return `Every ${DAY_NAMES[dayNum]} ${timeStr}`;
    }
    return `${timeStr} on day-of-week ${dowField}`;
  }

  // Specific day of month
  if (minute !== null && hour !== null && domField !== "*" && monField === "*" && dowField === "*") {
    const dom = parseInt(domField, 10);
    if (!Number.isNaN(dom)) {
      const suffix = dom === 1 || dom === 21 || dom === 31 ? "st" : dom === 2 || dom === 22 ? "nd" : dom === 3 || dom === 23 ? "rd" : "th";
      return `${timeStr} on the ${dom}${suffix} of every month`;
    }
  }

  // Specific month + day
  if (minute !== null && hour !== null && domField !== "*" && monField !== "*") {
    const mon = parseInt(monField, 10);
    const dom = parseInt(domField, 10);
    if (!Number.isNaN(mon) && mon >= 1 && mon <= 12 && !Number.isNaN(dom)) {
      return `${timeStr} on ${MONTH_NAMES[mon]} ${dom}`;
    }
  }

  // Daily at specific time
  if (minute !== null && hour !== null && domField === "*" && monField === "*" && dowField === "*") {
    return `Every day ${timeStr}`;
  }

  return "Custom schedule";
}

// ── Next run times ───────────────────────────────────────────────────

function fieldMatches(field: string, value: number, max: number): boolean {
  if (field === "*") return true;

  for (const part of field.split(",")) {
    // Range with step: 1-5/2
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      if (Number.isNaN(step) || step <= 0) continue;
      let start = 0;
      let end = max;
      if (range !== "*") {
        if (range.includes("-")) {
          const [a, b] = range.split("-").map(Number);
          start = a;
          end = b;
        } else {
          start = parseInt(range, 10);
          end = max;
        }
      }
      for (let i = start; i <= end; i += step) {
        if (i === value) return true;
      }
      continue;
    }

    // Range: 1-5
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (value >= a && value <= b) return true;
      continue;
    }

    // Exact value
    if (parseInt(part, 10) === value) return true;
  }

  return false;
}

function cronMatchesDate(parts: string[], date: Date): boolean {
  const [minField, hourField, domField, monField, dowField] = parts;
  return (
    fieldMatches(minField, date.getUTCMinutes(), 59) &&
    fieldMatches(hourField, date.getUTCHours(), 23) &&
    fieldMatches(domField, date.getUTCDate(), 31) &&
    fieldMatches(monField, date.getUTCMonth() + 1, 12) &&
    fieldMatches(dowField, date.getUTCDay(), 6)
  );
}

/**
 * Compute the next N run times for a cron expression (UTC).
 * Scans minute-by-minute from `from` up to 366 days out.
 */
export function nextRunTimes(expr: string, count: number, from: Date = new Date()): Date[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return [];

  const results: Date[] = [];
  const cursor = new Date(from);
  // Round up to next minute
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const maxIterations = 366 * 24 * 60; // 1 year of minutes
  for (let i = 0; i < maxIterations && results.length < count; i++) {
    if (cronMatchesDate(parts, cursor)) {
      results.push(new Date(cursor));
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  return results;
}

/**
 * Basic validation: 5 space-separated fields, each containing valid cron characters.
 */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[0-9*,\-/]+$/.test(p));
}
