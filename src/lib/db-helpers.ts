import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "../db";

export async function requireEmployee(employeeId: number) {
  const employee = await db.query.employeesTable.findFirst({
    where: eq(schema.employeesTable.id, employeeId),
  });

  if (!employee) {
    throw new HTTPException(404, { message: "employee not found" });
  }

  return employee;
}

export async function requireManager(managerId: number) {
  const manager = await db.query.managersTable.findFirst({
    where: eq(schema.managersTable.id, managerId),
  });

  if (!manager) throw new HTTPException(404, { message: "approver not found" });

  return manager;
}

export async function requireTimeEntry(
  timeEntryId: number,
  employeeId: number,
) {
  const entry = await db.query.timeEntriesTable.findFirst({
    where: and(
      eq(schema.timeEntriesTable.id, timeEntryId),
      eq(schema.timeEntriesTable.employeeId, employeeId),
    ),
  });

  if (!entry) throw new HTTPException(404, { message: "time entry not found" });

  return entry;
}
