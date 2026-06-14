import type { TimeEntry } from "../db/schema";

/**
 * A single time entry can be at most this many hours. Time tracking feeds
 * payroll, so an entry longer than a full day is almost certainly a typo
 * (e.g. a wrong AM/PM or a forgotten clock-out) rather than real work. We
 * reject it at write time instead of letting it flow into someone's paycheck.
 */
export const MAX_ENTRY_HOURS = 24;

export const MS_PER_HOUR = 1000 * 60 * 60;

/** Hours between two instants, rounded to 2 decimals. */
export function hoursBetween(start: Date, end: Date): number {
  return (
    Math.round(((end.getTime() - start.getTime()) / MS_PER_HOUR) * 100) / 100
  );
}

/**
 * Two half-open intervals [aStart, aEnd) and [bStart, bEnd) overlap iff each
 * starts before the other ends. Half-open means a 09:00–17:00 entry and a
 * 17:00–18:00 entry are adjacent, not overlapping.
 */
export function intervalsOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * The 7-day window for a weekly summary. `weekStart` is treated as the first
 * day of the week (we do not snap it to a Monday).
 * Returns [start, end) where end is exclusive. All boundaries are computed in
 * UTC so the window does not shift with the server's local timezone.
 */
export function weekRange(weekStart: Date): { start: Date; end: Date } {
  const start = new Date(weekStart);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

export interface WeeklySummary {
  totalHours: number;
  approvedHours: number;
  pendingHours: number;
  byProject: Record<string, number>;
  entryCount: number;
}

/**
 * Aggregate a set of entries into a weekly summary. Rejected entries are
 * excluded entirely — they represent disputed time that should not reach
 * payroll. Approved vs. pending is surfaced separately so payroll knows what
 * is actually payable now vs. still awaiting a manager.
 */
export function summarize(entries: TimeEntry[]): WeeklySummary {
  const summary: WeeklySummary = {
    totalHours: 0,
    approvedHours: 0,
    pendingHours: 0,
    byProject: {},
    entryCount: 0,
  };

  for (const entry of entries) {
    if (entry.status === "rejected") continue;

    const hours = hoursBetween(entry.startTime, entry.endTime);
    summary.totalHours += hours;
    summary.entryCount += 1;
    summary.byProject[entry.project] = (summary.byProject[entry.project] ?? 0) +
      hours;

    if (entry.status === "approved") summary.approvedHours += hours;
    else summary.pendingHours += hours;
  }

  // Re-round the accumulated totals so floating point drift doesn't surface.
  summary.totalHours = round2(summary.totalHours);
  summary.approvedHours = round2(summary.approvedHours);
  summary.pendingHours = round2(summary.pendingHours);
  for (const project of Object.keys(summary.byProject)) {
    summary.byProject[project] = round2(summary.byProject[project]);
  }

  return summary;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
