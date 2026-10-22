# Teaching workflow expansion — release 22 October 2026

The user approved production connection and publication on 22 October 2026.
Migrations 003–006 were successfully applied through the Supabase SQL editor;
the read-only installation report passed all seven checks, including a successful
cron run. Frontend publication is carried by this scoped release commit. This
record does not claim a production end-to-end run that creates or changes real
student work or grades.

## User decisions

- Grading is roster based. Reserving seminar questions or marking a defence is
  never required to enter, save or publish a score. Existing optional group
  reservations remain under a collapsed additional-information block.
- Scheduled publications have a separate `Заплановані` button and a list with
  a group filter, exact Kyiv publication time, edit and cancel-to-draft actions.
- Generic `.xlsx` journal export is delivered now. The user will find and send
  an anonymized department grade-statement template later. Remind them in the
  completion message. The generic export is not labelled an official statement.

## Implemented surface

1. `Викладання → Мій розклад`: all currently permitted accepted course/group
   timetable occurrences, seven-day navigation, group and personal-slot filters.
   Personal slot marks do not change group schedules or grant permissions.
   Opening a lesson opens its group's journal on that date; if there is no work
   on that date, another date is not silently selected for quick entry.
2. `Заплановані`: all accessible scheduled assignments/materials, group filter,
   editing through the current course snapshot and versioned cancellation.
   Server execution uses the existing Supabase database; installation is explicit.
3. Publication editor: written/oral/defence format, independent due date and final
   submission cutoff, optional five-day preset, immediate or scheduled publication.
   Google Drive/video resources are explicit links; file-picker OAuth, remote
   storage quotas and remote sharing permissions are not implemented or changed.
4. Review: an assignment editor can grant a versioned individual extension.
   Cutoff affects final submission, not private draft storage, review or grading.
5. Journal: quick roster entry with all-or-nothing draft batch save, existing
   per-work publication, category coefficients and explicit final rounding.
   Raw scores stay unchanged; absent scores and numerical zero are distinct.
6. Export: real `.xlsx` with published scores, calculation rules and summary;
   CSV remains available. Untrusted text is emitted as strings, not formulas.
7. Student requests: own visible journal work can be queried even before a score
   appears. Students see their own requests; current course graders can answer.
   Answering a request never changes grades by itself.
8. Existing co-teacher invitations, semester copying, archives, author-managed
   materials and postgraduate/teacher role coexistence are reused.

## Activation sequence

The server was applied before publishing the frontend, in this order:

1. `202610220003_teaching_workflow_expansion.sql`
2. `202610220004_teaching_grading_rules.sql`
3. `202610220005_teaching_calendar.sql`
4. `202610220006_teaching_grade_requests.sql`

Each migration is transactional. Workflow SQL validates exact installed-function
anchors; a mismatch must be inspected rather than bypassed. See
`teaching-workflow-server.md` for restricted RPCs, cron installation and receipts.
The existing pg_cron extension let migration 003 install the canonical job from
the database operator role. Job 5, `xelay-teaching-publications`, runs every minute;
the observed run at 20:15 UTC succeeded. Scheduled publications remain private
until the server publisher succeeds. Missing or altered job configuration makes
new scheduling fail closed.

The frontend release is a carefully scoped commit. Existing assistant, iOS,
package and Vercel configuration edits are unrelated and stay local.
No local build or automated test suite was requested or run for this work.
TypeScript checks passed during preparation; recheck after final edits.

## Preparation evidence

- Final TypeScript check completed with exit code 0.
- Read-only Supabase catalog export confirmed all 18 prerequisite functions,
  expected existing/new table and column flags, and the original status constraint.
  The existing database already has `pg_cron` 1.6.4.
- Exact catalog sources were exported as base64 after the browser accessibility
  representation proved to collapse spaces in JSON string values. All 26
  canonical anchors match the actual server definitions. The first activation
  transaction rolled back because pasted SQL uses CRLF; the patcher now removes
  CR symmetrically from the source and comparison/replacement fragments. SQL
  tokens and function literal contents are not otherwise normalized or bypassed.
- Installation was then confirmed by a metadata-only report covering RPC grants,
  private table RLS/ACL, columns, constraints, indexes, contract markers and the
  canonical job's latest successful run. Receipt:
  `a558faa6-c054-4374-8ec9-16a4fd764ffa`.
- No acceptance run that creates real teaching items or changes student grades
  was performed as part of publication. Catalog checks confirm installation,
  not every production end-to-end user scenario.

## Local preview

`http://127.0.0.1:3032/.teaching-preview.local/index.html`

The banner identifies fictional data. The preview stores changes only in the
browser. Its scheduled publisher is a local read-time simulation, not proof of
the production cron or production access policies. Production installation is
recorded above; separate end-to-end acceptance would require its own workflow.
