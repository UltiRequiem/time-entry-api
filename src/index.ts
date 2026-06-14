import { zValidator } from "@hono/zod-validator";
import { and, eq, gt, gte, lt, ne } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { trimTrailingSlash } from "hono/trailing-slash";
import z from "zod";
import { db } from "./db";
import {
  employeesTable,
  managersTable,
  timeEntriesTable,
} from "./db/schema";
import {
  hoursBetween,
  MAX_ENTRY_HOURS,
  summarize,
  weekRange,
} from "./lib/time-entries";

const app = new Hono();

app.use(trimTrailingSlash());

// Shared hook for all zValidator calls. Returns a consistent { error, issues }
// envelope instead of the default stringified ZodError blob.
const validationHook = (
  result: {
    success: boolean;
    // Zod v4 uses PropertyKey[] (string | number | symbol) for issue paths.
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  },
  c: Context,
) => {
  if (!result.success) {
    return c.json(
      {
        error: "invalid request",
        issues: result.error!.issues.map((i) => ({
          ...(i.path.length && { path: i.path.map(String).join(".") }),
          message: i.message,
        })),
      },
      400,
    );
  }
};

const employeeIdParam = z.object({
  employeeId: z.coerce.number().int().positive(),
});

/**
 * POST /employees/:employeeId/time-entries
 * Create a time entry for an employee.
 */
app.post(
  "/employees/:employeeId/time-entries",
  zValidator("param", employeeIdParam, validationHook),
  zValidator(
    "json",
    z
      .object({
        startTime: z.coerce.date(),
        endTime: z.coerce.date(),
        project: z.string().trim().min(1),
        notes: z.string().trim().optional(),
      })
      .refine((data) => data.endTime > data.startTime, {
        message: "endTime must be after startTime",
        path: ["endTime"],
      })
      .refine(
        (data) =>
          hoursBetween(data.startTime, data.endTime) <= MAX_ENTRY_HOURS,
        {
          message: `a single entry cannot exceed ${MAX_ENTRY_HOURS} hours`,
          path: ["endTime"],
        },
      ),
    validationHook,
  ),
  async (c) => {
    const { employeeId } = c.req.valid("param");
    const { startTime, endTime, project, notes } = c.req.valid("json");

    const employee = await db.query.employeesTable.findFirst({
      where: eq(employeesTable.id, employeeId),
    });
    if (!employee) {
      throw new HTTPException(404, { message: "employee not found" });
    }

    // Data integrity: an employee cannot be in two places at once. Reject an
    // entry that overlaps an existing pending/approved one. Rejected entries
    // are ignored so a corrected re-submission is allowed.
    // intervalsOverlap([a,b), [c,d)) ≡ a < d && c < b — pushed to DB so we
    // never load unbounded history into memory.
    const clash = await db.query.timeEntriesTable.findFirst({
      where: and(
        eq(timeEntriesTable.employeeId, employeeId),
        ne(timeEntriesTable.status, "rejected"),
        lt(timeEntriesTable.startTime, endTime),
        gt(timeEntriesTable.endTime, startTime),
      ),
    });
    if (clash) {
      throw new HTTPException(409, {
        message: `overlaps existing time entry ${clash.id}`,
      });
    }

    const [created] = await db
      .insert(timeEntriesTable)
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
  zValidator(
    "query",
    z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .refine((q) => !q.from || !q.to || q.from <= q.to, {
        message: "from must be on or before to",
        path: ["from"],
      }),
    validationHook,
  ),
  async (c) => {
    const { employeeId } = c.req.valid("param");
    const { from, to } = c.req.valid("query");

    const employee = await db.query.employeesTable.findFirst({
      where: eq(employeesTable.id, employeeId),
    });
    if (!employee) {
      throw new HTTPException(404, { message: "employee not found" });
    }

    const filters = [eq(timeEntriesTable.employeeId, employeeId)];
    if (from) filters.push(gte(timeEntriesTable.startTime, from));
    if (to) {
      // Make `to` inclusive of the whole day by going to the next UTC midnight.
      const toExclusive = new Date(to);
      toExclusive.setUTCHours(0, 0, 0, 0);
      toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
      filters.push(lt(timeEntriesTable.startTime, toExclusive));
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
  zValidator(
    "param",
    employeeIdParam.extend({
      timeEntryId: z.coerce.number().int().positive(),
      action: z.enum(["approve", "reject"]),
    }),
    validationHook,
  ),
  zValidator(
    "json",
    z.object({
      approverId: z.coerce.number().int().positive(),
    }),
    validationHook,
  ),
  async (c) => {
    const { employeeId, timeEntryId, action } = c.req.valid("param");
    const { approverId } = c.req.valid("json");

    const entry = await db.query.timeEntriesTable.findFirst({
      where: and(
        eq(timeEntriesTable.id, timeEntryId),
        eq(timeEntriesTable.employeeId, employeeId),
      ),
    });
    if (!entry) {
      throw new HTTPException(404, { message: "time entry not found" });
    }

    // The reviewer must be a real manager. (Self-approval is impossible by
    // construction: approverId points at the managers table, the entry owner
    // at the employees table — separate id spaces.)
    const manager = await db.query.managersTable.findFirst({
      where: eq(managersTable.id, approverId),
    });
    if (!manager) {
      throw new HTTPException(404, { message: "approver not found" });
    }

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
      .update(timeEntriesTable)
      .set({ status: newStatus, approverId, reviewedAt: new Date() })
      .where(eq(timeEntriesTable.id, timeEntryId))
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
  zValidator(
    "query",
    z.object({
      week: z.coerce.date().optional(),
    }),
    validationHook,
  ),
  async (c) => {
    const { employeeId } = c.req.valid("param");
    const { week } = c.req.valid("query");

    const employee = await db.query.employeesTable.findFirst({
      where: eq(employeesTable.id, employeeId),
    });
    if (!employee) {
      throw new HTTPException(404, { message: "employee not found" });
    }

    const { start, end } = weekRange(week ?? new Date());

    const entries = await db.query.timeEntriesTable.findMany({
      where: and(
        eq(timeEntriesTable.employeeId, employeeId),
        gte(timeEntriesTable.startTime, start),
        lt(timeEntriesTable.startTime, end),
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
