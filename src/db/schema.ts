import { int, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const employeesTable = sqliteTable("employees_table", {
  id: int().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  lastName: text("last_name").notNull(),
  role: text().notNull(),
});

export const managersTable = sqliteTable("managers_table", {
  id: int().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  lastName: text("last_name").notNull(),
});

export const timeEntriesTable = sqliteTable("time_entries_table", {
  id: int().primaryKey({ autoIncrement: true }),
  // No cascade delete for employee. We want to keep time entries even if an employee is deleted to preserve historical data integrity.
  employeeId: int("employee_id")
    .notNull()
    .references(() => employeesTable.id),
  // The reviewer is always a manager, never the employee who owns the entry.
  // Because employees and managers live in separate tables, a self-approval is
  // structurally impossible — there is no shared id space to collide on.
  // No cascade delete for approver. We want to keep time entries even if a manager is deleted to preserve historical data integrity.
  approverId: int("approver_id").references(() => managersTable.id),
  startTime: integer("start_time", { mode: "timestamp" }).notNull(),
  endTime: integer("end_time", { mode: "timestamp" }).notNull(),
  project: text().notNull(),
  notes: text(),
  status: text("status", { enum: ["pending", "approved", "rejected"] })
    .notNull()
    .default("pending"),
  // When a manager approved or rejected the entry. Null while pending.
  reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type TimeEntry = typeof timeEntriesTable.$inferSelect;
