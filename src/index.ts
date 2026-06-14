import { zValidator } from "@hono/zod-validator";
import { and, eq, gt, gte, lt, ne } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { trimTrailingSlash } from "hono/trailing-slash";

import { db, schema } from "./db";
import {
  requireEmployee,
  requireManager,
  requireTimeEntry,
} from "./lib/db-helpers";
import { summarize, weekRange } from "./lib/time-entries";
import { validationHook } from "./lib/validation";

import {
  createEntryBody,
  employeeIdParam,
  listEntriesQuery,
  managerActionBody,
  managerActionParam,
  weeklySummaryQuery,
} from "./schemas";

const app = new Hono();

app.use(trimTrailingSlash());

/**
 * POST /employees/:employeeId/time-entries
 * Create a time entry for an employee.
 */
app.post(
  "/employees/:employeeId/time-entries",
  zValidator("param", employeeIdParam, validationHook),
  zValidator("json", createEntryBody, validationHook),
  async (c) => {
    const { employeeId } = c.req.valid("param");
    const { startTime, endTime, project, notes } = c.req.valid("json");

    await requireEmployee(employeeId);

    // Data integrity: an employee cannot be in two places at once. Reject an
    // entry that overlaps an existing pending/approved one. Rejected entries
    // are ignored so a corrected re-submission is allowed.
    // intervalsOverlap([a,b), [c,d)) ≡ a < d && c < b — pushed to DB so we
    // never load unbounded history into memory.
    const clash = await db.query.timeEntriesTable.findFirst({
      where: and(
        eq(schema.timeEntriesTable.employeeId, employeeId),
        ne(schema.timeEntriesTable.status, "rejected"),
        lt(schema.timeEntriesTable.startTime, endTime),
        gt(schema.timeEntriesTable.endTime, startTime),
      ),
    });
    if (clash) {
      throw new HTTPException(409, {
        message: `overlaps existing time entry ${clash.id}`,
      });
    }

    const [created] = await db
      .insert(schema.timeEntriesTable)
      .values({ employeeId, startTime, endTime, project, notes })
      .returning();

    return c.json(created, 201);
  },
);

/**
 * GET /employees/:employeeId/time-entries?from=YYYY-MM-DD&to=YYYY-MM-DD
 * List an employee's time entries. The range filters on the entry's startTime
 * and is inclusive on both ends (an entry starting on `to` is included).
 */
app.get(
  "/employees/:employeeId/time-entries",
  zValidator("param", employeeIdParam, validationHook),
  zValidator("query", listEntriesQuery, validationHook),
  async (c) => {
    const { employeeId } = c.req.valid("param");
    const { from, to } = c.req.valid("query");

    await requireEmployee(employeeId);

    const filters = [eq(schema.timeEntriesTable.employeeId, employeeId)];
    if (from) filters.push(gte(schema.timeEntriesTable.startTime, from));
    if (to) {
      // Make `to` inclusive of the whole day by going to the next UTC midnight.
      const toExclusive = new Date(to);
      toExclusive.setUTCHours(0, 0, 0, 0);
      toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
      filters.push(lt(schema.timeEntriesTable.startTime, toExclusive));
    }

    const entries = await db.query.timeEntriesTable.findMany({
      where: and(...filters),
      orderBy: (t, { asc }) => [asc(t.startTime)],
    });

    return c.json({ employeeId, count: entries.length, entries });
  },
);

/**
 * POST /employees/:employeeId/time-entries/:timeEntryId/:action
 * Manager action on an entry. `action` is approve | reject.
 */
app.post(
  "/employees/:employeeId/time-entries/:timeEntryId/:action",
  zValidator("param", managerActionParam, validationHook),
  zValidator("json", managerActionBody, validationHook),
  async (c) => {
    const { employeeId, timeEntryId, action } = c.req.valid("param");
    const { approverId } = c.req.valid("json");

    const entry = await requireTimeEntry(timeEntryId, employeeId);
    // Self-approval is impossible by construction: approverId points at the
    // managers table, the entry owner at the employees table — separate id spaces.
    await requireManager(approverId);

    // An entry can only be acted on while pending. Re-approving or flipping an
    // already-decided entry would silently rewrite payroll history, so we
    // reject it and let the caller see the current state.
    if (entry.status !== "pending") {
      throw new HTTPException(409, {
        message: `time entry is already ${entry.status}`,
      });
    }

    const newStatus = action === "approve" ? "approved" : "rejected";
    const [updated] = await db
      .update(schema.timeEntriesTable)
      .set({ status: newStatus, approverId, reviewedAt: new Date() })
      .where(eq(schema.timeEntriesTable.id, timeEntryId))
      .returning();

    return c.json(updated);
  },
);

/**
 * GET /employees/:employeeId/weekly-summary?week=YYYY-MM-DD
 * Total hours, breakdown by project, and approved vs. pending for the 7-day
 * window starting at `week`. Defaults to the current week if omitted.
 */
app.get(
  "/employees/:employeeId/weekly-summary",
  zValidator("param", employeeIdParam, validationHook),
  zValidator("query", weeklySummaryQuery, validationHook),
  async (c) => {
    const { employeeId } = c.req.valid("param");
    const { week } = c.req.valid("query");

    await requireEmployee(employeeId);

    const { start, end } = weekRange(week ?? new Date());

    const entries = await db.query.timeEntriesTable.findMany({
      where: and(
        eq(schema.timeEntriesTable.employeeId, employeeId),
        gte(schema.timeEntriesTable.startTime, start),
        lt(schema.timeEntriesTable.startTime, end),
      ),
    });

    return c.json({
      employeeId,
      weekStart: start.toISOString().slice(0, 10),
      weekEnd: end.toISOString().slice(0, 10),
      ...summarize(entries),
    });
  },
);

// Consistent JSON error envelope for thrown HTTPExceptions and anything else.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: "internal server error" }, 500);
});

export default app;
