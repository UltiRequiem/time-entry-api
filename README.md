# Time Entry API

A small HTTP API for the time-tracking slice of an HRIS: employees log work
hours, managers approve them, and a weekly summary rolls the approved/pending
totals up for payroll.

**Stack:** Bun + Hono (HTTP), Drizzle ORM over SQLite (libsql), Zod for input
validation.

## Running it

```sh
bun install
bun run db:push    # create the SQLite schema in ./local.db
bun run db:seed    # insert 2 employees (id 1, 2) and 1 manager (id 1)
bun run dev        # http://localhost:3000
```

The foreign keys mean entries can only be created for seeded employees, and
only seeded managers can approve — run the seed first.

## API

All request/response bodies are JSON and camelCase.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/employees/:employeeId/time-entries` | Create an entry |
| `GET` | `/employees/:employeeId/time-entries?from=YYYY-MM-DD&to=YYYY-MM-DD` | List entries (range optional, inclusive, filtered by start date) |
| `POST` | `/employees/:employeeId/time-entries/:id/:action` | Manager action — `action` is `approve` or `reject` |
| `GET` | `/employees/:employeeId/weekly-summary?week=YYYY-MM-DD` | Totals, by-project breakdown, approved vs. pending |

Create body:

```jsonc
{
  "startTime": "2026-06-03T09:00:00Z",  // full ISO instants, not date + time
  "endTime":   "2026-06-03T17:30:00Z",
  "project":   "HRIS-Migration",
  "notes":     "Schema work"            // optional
}
```

Approve/reject body: `{ "approverId": 1 }`.

---

### What I built, and what I deliberately didn't

**Built:** all four endpoints, backed by a real (file) SQLite store via Drizzle,
with input validation, a consistent JSON error envelope, and the data-integrity
checks that matter for payroll (see edge cases below). The hours/overlap/week
math is factored into pure functions in [src/lib/time-entries.ts](src/lib/time-entries.ts)
so the rules are readable and unit-testable in isolation.

**Didn't build, on purpose:** auth, pagination, editing/deleting entries,
multi-tenancy, and automated tests (see the tests note below). No frontend or
OpenAPI docs — the brief explicitly de-prioritized those.

### Ambiguities I found, and how I resolved them

I resolved these by **making and documenting assumptions** rather than waiting on
answers, since the brief invited that and none of them are one-way doors:

1. **`date` + `start_time` + `end_time` vs. full instants.** The original brief
   modeled an entry as a calendar date plus two wall-clock times. That can't
   represent a shift that crosses midnight without ambiguity. I store two full
   ISO instants instead; midnight-spanning is then just an entry whose start and
   end fall on different days, with zero special-casing.
2. **Employee/manager identity.** I kept them as separate tables (and integer
   ids rather than the `emp_123`/`mgr_456` strings). A pleasant side effect:
   **self-approval is structurally impossible** — an approver id points at the
   managers table, an entry's owner at the employees table, so there's no shared
   id space to collide on.
3. **"Week" semantics.** `week=2026-06-01` is treated as the first day of a
   7-day window `[week, week+7)`. I do **not** snap it to a Monday — the caller
   says where the week starts. Entries are bucketed by their `startTime`.
4. **Timezone.** All boundary math is done in **UTC** so a weekly window or a
   list range doesn't shift depending on what timezone the server runs in. (This
   was a real bug first — see the LLM section.)
5. **`weekly-summary` verb.** I made it a `GET` (it's a pure read) even though an
   earlier draft had it as `POST`.

### Edge cases handled

- **End before/equal to start** → `400`. A zero or negative duration is never
  valid work.
- **Entry longer than 24h** → `400`. Feeds payroll; a >1-day entry is almost
  always a typo (wrong AM/PM, forgotten clock-out) and shouldn't reach a
  paycheck. The cap lives in one named constant.
- **Overlapping entries** for the same employee → `409`. You can't be in two
  places at once. Overlap uses half-open intervals, so `09–17` and `17–18` are
  adjacent, not a conflict. Rejected entries are ignored, so a corrected
  re-submission is allowed.
- **Approving an already-decided entry** → `409`. Re-approving or flipping a
  decided entry would silently rewrite payroll history; only `pending` entries
  can be acted on.
- **Unknown employee / manager / entry** → `404`, including the case where the
  `:id` in the approve path doesn't belong to the `:employeeId` in the path.
- **Self-approval** → impossible by construction (see above).

### Edge cases I consciously skipped

- **Concurrency / double-submit.** Two simultaneous creates could both pass the
  overlap check and both insert (TOCTOU); two approvals could race. The
  bulletproof fix is a DB-level exclusion constraint or `SELECT ... FOR UPDATE`
  in a transaction. Out of scope for this store, but flagged.
- **Future-dated entries** are allowed. Logging planned time is plausible and
  the brief didn't say otherwise.
- **Entries spanning a week boundary** are counted whole in the week of their
  `startTime` rather than split across two weeks. Documented, not split.
- **Daylight-saving / per-employee timezones.** Everything is UTC; real payroll
  needs the employee's local timezone to define "a day" and "a week."

### How I used LLM tools

I drove this with Claude Code: it generated the schema fixes, the route
handlers, and the pure helpers, and I steered the design decisions and reviewed
every diff.

- **Accepted as-is:** the half-open-interval overlap check
  (`aStart < bEnd && bStart < aEnd`) and the by-project/approved-vs-pending
  aggregation. The logic was correct and matched how I'd write it, so it stood.
- **Pushed back / rewrote:** the first cut of the weekly window used local-time
  `setHours(0,0,0,0)` on a date that had been parsed as UTC. An end-to-end test
  surfaced it immediately — `week=2026-06-01` came back as `weekStart:
  2026-05-31`, an off-by-one driven purely by the server's timezone. For payroll
  that's the worst kind of bug (silently moves hours between weeks), so I
  rewrote all boundary math onto `setUTCHours`/`setUTCDate` and standardized on
  UTC.

### Tradeoffs I'd revisit for production

- **No transactions around check-then-write.** The overlap and status checks are
  read-then-write and not atomic. Production needs them inside a transaction
  with a uniqueness/exclusion constraint as the real backstop.
- **24h cap and overlap rules are hard-coded** policy. In reality these are
  org/jurisdiction config, not constants in a helper.
- **FK enforcement.** SQLite doesn't enforce foreign keys unless
  `PRAGMA foreign_keys = ON`; I rely on explicit existence checks in code. A real
  DB would enforce at the schema level too.
- **No audit trail beyond `reviewedAt`/`approverId`.** Payroll disputes want a
  full history of who changed what, when.

### How I decided it was done

All four endpoints work against a real store, and every edge case the brief
called out (midnight spans, overlaps, end-before-start, re-approval,
self-approval) has an explicit, hand-tested behavior with the right status code.
I ran a full happy-path + edge-case curl suite end to end and `tsc` passes
clean. The brief asked for a small slice done with judgment, not breadth — once
the integrity rules were solid and documented, expanding scope would have worked
against the point of the exercise.

### What would scare a teammate most

The **check-then-write race**. The overlap and "still pending?" guards are
correct under sequential calls but not atomic, so under real concurrency two
requests can both pass the check and write. It's the gap between "looks correct
in a demo" and "correct under load," and it's invisible until two requests land
in the same millisecond — exactly the kind of thing that corrupts payroll
quietly. The fix is known (transaction + DB constraint); I left it out to keep
the slice small, but it's the first thing I'd close before this touched real
money.

### A note on tests

I skipped an automated test suite to stay inside the spirit of the slice, but
the code is shaped for it: all the rules (`hoursBetween`, `intervalsOverlap`,
`weekRange`, `summarize`) are pure functions in one file and would be quick to
cover with a `bun test` file. I verified behavior with an end-to-end curl run
instead.
