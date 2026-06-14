# API Reference

## Stack

Bun + Hono (HTTP), Drizzle ORM over SQLite (libsql), Zod for input validation.

## Running it

```sh
bun install
bun run db:push    # create the SQLite schema in ./local.db
bun run db:seed    # insert 2 employees (id 1, 2) and 1 manager (id 1)
bun run dev        # http://localhost:3000
```

Foreign key enforcement is on (`PRAGMA foreign_keys = ON`), so entries can only
be created for seeded employees and only seeded managers can approve. Run the
seed before hitting the API.

## Endpoints

All request/response bodies are JSON and camelCase.

| Method | Path                                                                | Purpose                                                                        |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `POST` | `/employees/:employeeId/time-entries`                               | Create a time entry                                                            |
| `GET`  | `/employees/:employeeId/time-entries?from=YYYY-MM-DD&to=YYYY-MM-DD` | List entries (date range optional, both ends inclusive, filtered on startTime) |
| `POST` | `/employees/:employeeId/time-entries/:id/approve`                   | Approve a pending entry                                                        |
| `POST` | `/employees/:employeeId/time-entries/:id/reject`                    | Reject a pending entry                                                         |
| `GET`  | `/employees/:employeeId/weekly-summary?week=YYYY-MM-DD`             | Totals, by-project breakdown, approved vs. pending                             |

## Request bodies

### Create entry

```jsonc
{
  "startTime": "2026-06-03T09:00:00Z", // full ISO instant — not a date + wall-clock pair
  "endTime": "2026-06-03T17:30:00Z",
  "project": "HRIS-Migration",
  "notes": "Schema work" // optional
}
```

Midnight-spanning shifts work naturally: `startTime` and `endTime` are just two
instants; no special-casing required.

### Approve / reject

```json
{ "approverId": 1 }
```

`approverId` must reference a row in the managers table. The manager and
employee live in separate tables, so self-approval is structurally impossible —
there is no shared id space.

### List query params

| Param  | Format       | Behaviour                                                                      |
| ------ | ------------ | ------------------------------------------------------------------------------ |
| `from` | `YYYY-MM-DD` | Include entries with `startTime >= from` (start of day UTC)                    |
| `to`   | `YYYY-MM-DD` | Include entries with `startTime` on or before `to` (end of day UTC, inclusive) |

## Response shapes

### Time entry object

```jsonc
{
  "id": 1,
  "employeeId": 1,
  "startTime": "2026-06-03T09:00:00.000Z",
  "endTime": "2026-06-03T17:30:00.000Z",
  "project": "HRIS-Migration",
  "notes": "Schema work",
  "status": "pending", // "pending" | "approved" | "rejected"
  "approverId": null, // set when approved/rejected
  "reviewedAt": null, // timestamp set when approved/rejected
  "createdAt": "2026-06-03T..."
}
```

### List response

```json
{
  "employeeId": 1,
  "count": 2,
  "entries": [ ...time entry objects... ]
}
```

### Weekly summary

```jsonc
{
  "employeeId": 1,
  "weekStart": "2026-06-01", // first day of the 7-day window
  "weekEnd": "2026-06-08", // exclusive upper bound
  "totalHours": 16.5, // approved + pending; rejected entries excluded
  "approvedHours": 8.0,
  "pendingHours": 8.5,
  "byProject": {
    "HRIS-Migration": 8.0,
    "Payroll-Audit": 8.5
  },
  "entryCount": 2
}
```

Rejected entries are excluded entirely from all totals — they represent disputed
time that should not reach payroll.

## Error responses

All errors return `{ "error": "<message>" }` with an appropriate HTTP status.

Validation errors (400) include a structured `issues` array instead of a raw Zod
blob:

```json
{
  "error": "invalid request",
  "issues": [
    { "path": "endTime", "message": "endTime must be after startTime" }
  ]
}
```

| Status | Meaning                                                            |
| ------ | ------------------------------------------------------------------ |
| 400    | Validation failure (see `issues` array)                            |
| 404    | Employee, manager, or time entry not found                         |
| 409    | Overlap with existing entry; or entry is already approved/rejected |
| 500    | Unexpected server error                                            |

## Testing with Postman

Import `postman_collection.json` and `postman_environment.json` into Postman.
The collection covers the happy path, all error conditions, and chains the
approve/reject flow via collection variables — no manual ID copy-paste needed.
Requires a running server and seeded DB.
