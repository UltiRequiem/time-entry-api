import z from "zod";
import { hoursBetween, MAX_ENTRY_HOURS } from "./lib/time-entries";

export const employeeIdParam = z.object({
  employeeId: z.coerce.number().int().positive(),
});

export const createEntryBody = z
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
    (data) => hoursBetween(data.startTime, data.endTime) <= MAX_ENTRY_HOURS,
    {
      message: `a single entry cannot exceed ${MAX_ENTRY_HOURS} hours`,
      path: ["endTime"],
    },
  );

export const listEntriesQuery = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "from must be on or before to",
    path: ["from"],
  });

export const managerActionParam = employeeIdParam.extend({
  timeEntryId: z.coerce.number().int().positive(),
  action: z.enum(["approve", "reject"]),
});

export const managerActionBody = z.object({
  approverId: z.coerce.number().int().positive(),
});

export const weeklySummaryQuery = z.object({
  week: z.coerce.date().optional(),
});
