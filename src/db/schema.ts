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
  employeeId: int("employee_id")
    .notNull()
    .references(() => employeesTable.id, { onDelete: "cascade" }),
  approverId: int("approver_id")
    .notNull()
    .references(
      () => managersTable.id,
    ) /* No cascade delete for approver. We want to keep time entries even if a manager is deleted */,
  startTime: integer("start_time", { mode: "timestamp" }).notNull(),
  endTime: integer("end_time", { mode: "timestamp" }).notNull(),
  status: text(["pending", "approved", "rejected"])
    .notNull()
    .default("pending"),
});
