# Time Entry API

A small HTTP API for the time-tracking slice of an HRIS: employees log work
hours, managers approve or reject them, and a weekly summary rolls the totals up
for payroll.

See [api.md](api.md) for endpoint reference, request/response shapes, and
Postman setup.

## What I built, and what I deliberately didn't

**Built:** all four endpoints from the brief, backed by a (file) SQLite store
via Drizzle, with input validation, a consistent JSON error envelope, and the
data-integrity checks that matter for payroll. I also implemented `reject` as
the natural pair to `approve`, the brief only called out approve, but a manager
needs to be able to dispute an entry too, and the action enum makes the endpoint
shape clean. The hours/overlap/week math is factored into pure functions so the
rules are readable and unit-testable in isolation.

**Didn't build, on purpose:** auth, pagination, editing or deleting entries,
multi-tenancy, and automated tests (see the tests note below). No frontend or
OpenAPI docs, the brief explicitly de-prioritized those.

## Ambiguities I found, and how I resolved them

I resolved these by making and documenting assumptions rather than asking, since
the brief invited that and none of them are one-way doors:

1. **`date` + `start_time` + `end_time` vs. full instants.** The brief modeled
   an entry as a calendar date plus two wall-clock times. That can't represent a
   shift that crosses midnight without ambiguity. I store two full ISO instants
   instead — midnight-spanning is then just an entry whose start and end fall on
   different days, with zero special-casing.

2. **Route shape.** The brief shows flat routes (`POST /time-entries`,
   `POST /time-entries/{id}/approve`). I nested everything under
   `/employees/:employeeId/` so the resource ownership is explicit in the URL
   and the employee can be validated at the routing layer. This is a deliberate
   deviation from the spec shape.

3. **Employee/manager identity.** I kept them as separate tables with integer
   ids rather than the `emp_123`/`mgr_456` strings. A side effect:
   **self-approval is structurally impossible** — an approver id points at the
   managers table, an entry's owner at the employees table, so there is no
   shared id space to collide on.

4. **"Week" semantics.** `week=2026-06-01` is treated as the first day of a
   7-day window `[week, week+7)`. I do not snap it to a Monday — the caller
   decides where the week starts. Entries are bucketed by their `startTime`.

5. **Timezone.** All boundary math uses `setUTCHours`/`setUTCDate` so a weekly
   window or list range doesn't shift depending on what timezone the server runs
   in.

## Edge cases handled

- **Shifts spanning midnight** → handled naturally. Entries are stored as two
  full timestamps, not a date plus wall-clock times, so a 10pm–2am shift is just
  an entry whose end falls on the next calendar date. No special-casing needed,
  and it works correctly regardless of the employee's timezone.
- **End before or equal to start** → `400`. Zero or negative duration is never
  valid work.
- **Entry longer than 24h** → `400`. A >1-day entry is almost always a typo
  (wrong AM/PM, forgotten clock-out) and shouldn't reach a paycheck. The cap is
  a named constant in one place.
- **Overlapping entries** for the same employee → `409`. You can't be in two
  places at once. Overlap uses half-open intervals, so `09–17` and `17–18` are
  adjacent, not a conflict. Rejected entries are excluded from the check, so a
  corrected re-submission is allowed. The check is pushed to the DB
  (`startTime < candidateEnd AND endTime > candidateStart`) so we never load
  unbounded history into memory.
- **Approving or flipping an already-decided entry** → `409`. Re-approving or
  rejecting a decided entry would silently rewrite payroll history; only
  `pending` entries can be acted on.
- **Unknown employee, manager, or entry** → `404` on every route, including the
  case where an entry id doesn't belong to the employee in the URL path.
- **Self-approval** → impossible by construction.
- **Concurrent creates / double-submit** → safe. The overlap check and insert
  run inside a single SQLite `IMMEDIATE` transaction, which acquires the write
  lock at `BEGIN` time. A second concurrent request blocks until the first
  commits, so two requests can never both pass the overlap check. Same pattern
  covers the approve/reject status check.
- **Malformed or invalid input** → `400` with a structured `{ error, issues }`
  array identifying the offending fields, not a raw Zod blob.

## Edge cases I consciously skipped

- **Future-dated entries** are allowed. Logging planned time is plausible and
  the brief didn't say otherwise.
- **Entries spanning a week boundary** are counted whole in the week of their
  `startTime`, not split. Documented assumption.
- **Daylight-saving / per-employee timezones.** Everything is UTC; real payroll
  needs the employee's local timezone to define "a day" and "a week."
- **Pagination.** The list endpoint returns all matching entries. Fine for this
  store; would need a limit/offset or cursor for production.

## How I used LLM tools

I drove this with Claude Code throughout: it generated the schema, route
handlers, and pure helpers, and I steered the design decisions and reviewed
every diff.

**Accepted as-is:** The weekly summary aggregation, split by project, approved
vs. pending, with a re-rounding pass on accumulated totals to prevent
floating-point drift. The logic was correct and matched how I'd write it, so it
stood.

**Pushed back / rewrote — two examples:**

1. _UTC boundary bug._ The first cut of the weekly window used local-time
   `setHours(0,0,0,0)` on a date parsed as UTC. A manual test surfaced it
   immediately — `week=2026-06-01` came back as `weekStart: 2026-05-31`, an
   off-by-one driven purely by the server's timezone. For payroll that's the
   worst kind of bug (silently moves hours between weeks), so I rewrote all
   boundary math onto `setUTCHours`/`setUTCDate`.

2. _Validation error format._ The default `@hono/zod-validator` error response
   was a stringified `ZodError` blob — `message` was a JSON string inside a JSON
   string, completely unusable for a client trying to show field-level errors. I
   asked for a structured `{ error, issues }` envelope where each issue surfaces
   its `path` and `message` cleanly. The implementation required knowing that
   Zod v4 uses `PropertyKey[]` (not `string[]`) for issue paths, which the first
   type-safe attempt got wrong — caught by `tsc`.

## Tradeoffs I'd revisit for production

- **24h cap and overlap rules are hard-coded.** In reality these are
  org/jurisdiction config, not constants in a helper file.
- **No audit trail beyond `reviewedAt` and `approverId`.** Payroll disputes want
  a full history of who changed what and when.
- **No pagination.** The list endpoint will return every matching entry forever.
  Needs a limit before the table gets large.
- **SQLite single-writer.** `IMMEDIATE` transactions serialize writes correctly,
  but SQLite's single global write lock becomes a bottleneck under real
  concurrent load. A production service would want Postgres with row-level
  locking and an exclusion constraint as a final backstop against overlaps.

## How I decided it was done

All four endpoints work against a real store, and every edge case the brief
called out, midnight spans, overlaps, end-before-start, re-approval,
self-approval, has an explicit, tested behavior with the right status code and a
clean error response. `tsc` passes clean. I ran the Postman collection
end-to-end (happy path and every error branch).

## What would scare a teammate most

The **absent audit trail**. `reviewedAt` and `approverId` capture the latest
decision, but nothing before it — no record of the original submission time, no
log of who changed what and from what state. In payroll that's a serious gap:
disputes, regulatory audits, and correction flows all need "show me the full
history of this entry." Right now, any update silently overwrites the prior
state. A proper audit log or event-sourced append-only table would close this.

## A note on tests

I skipped an automated test suite to stay inside the spirit of the slice, but
the code is shaped for it: all the business rules, duration calculation, overlap
detection, week windowing, summary aggregation, are pure functions with no side
effects and would be quick to cover with a unit test file.
