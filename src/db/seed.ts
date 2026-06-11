import { db } from ".";
import { employeesTable, managersTable, timeEntriesTable } from "./schema";

async function seed() {
  await db.delete(timeEntriesTable);
  await db.delete(employeesTable);
  await db.delete(managersTable);

  await db.insert(employeesTable).values([
    { id: 1, name: "Ada", lastName: "Lovelace", role: "engineer" },
    { id: 2, name: "Grace", lastName: "Hopper", role: "engineer" },
  ]);

  await db
    .insert(managersTable)
    .values([{ id: 1, name: "Alan", lastName: "Turing" }]);

  console.log("Seeded 2 employees and 1 manager.");
}

seed().then(() => process.exit(0));
