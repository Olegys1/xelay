# Android widget snapshot, schema 1

Base migration: `supabase/migrations/202610180007_android_widget_snapshot.sql`.
Additive upcoming-lesson migration:
`supabase/migrations/202610190001_android_widget_upcoming.sql`.
Both RPCs are authenticated, read-only, `SECURITY DEFINER`, with an empty search path.
They grant no table access and change no existing rows, RLS, submissions or rewards.
Use the signed-in user's access token, never a service-role key. The account must
exist, have confirmed email and not be deleted or currently banned.

## Group selection

`POST /rest/v1/rpc/xelay_android_widget_groups` with `{}`:

```json
{"groups":[{"id":"UUID","name":"МА-2","course":1,"degree":"bachelor"}],"truncated":false}
```

Only actual group representatives and accepted members are included. Invitations,
teacher-course links and platform-admin status alone grant no widget membership.
`course` is an integer from 1 to 6 derived from the group's immutable cohort and
the current academic year; an unknown or out-of-range course is `null`. `degree`
is `bachelor`, `master`, `postgraduate`, or `null`. Bind by UUID, never by name.
The response contains at most 50 groups; one extra candidate detects truncation.

## Snapshot

`POST /rest/v1/rpc/xelay_android_widget_snapshot` with `{"p_group_id":"UUID"}`:

```json
{
  "schema_version":1,
  "group":{"id":"UUID","name":"МА-2","course":1,"degree":"bachelor"},
  "generated_at":"2026-10-18T14:00:00.000Z",
  "timezone":"Europe/Kyiv",
  "schedule_date":"2026-10-19",
  "lessons":[{"id":"UUID","title":"Економічна теорія","kind":"seminar","start_time":"09:40","end_time":"11:00","location":"Аудиторія 101","url":"https://www.xelay.ink/groups/UUID?tab=schedule&date=2026-10-19"}],
  "deadlines":[{"id":"UUID","title":"Підготувати розрахунок","subject":"Економічна теорія","due_at":null,"due_date":"2026-10-19","source":"homework","url":"https://www.xelay.ink/groups/UUID?tab=schedule&date=2026-10-19&assignment=UUID&kind=homework"}],
  "truncated":false
}
```

All times and tomorrow's date are calculated from one server transaction snapshot.
Lesson times are Kyiv wall-clock values, not phone-local or UTC times. The server
uses the existing recurrence predicate for weekday, semester dates and upper/lower
week anchors, and separately omits excluded dates. One-day lessons and copied
Saturday schedules use their existing stored rows. At most 12 lessons are returned,
ordered by start, end and UUID; a thirteenth candidate detects truncation.

### Current and upcoming lessons

New clients use these additional fields in the same snapshot RPC:

```json
{
  "upcoming_schema_version":1,
  "upcoming_window_start":"2026-10-19",
  "upcoming_window_end":"2026-11-02",
  "upcoming_lessons":[
    {"id":"UUID","title":"Економічна теорія","kind":"seminar","lesson_date":"2026-10-19","start_time":"09:40","end_time":"11:00","starts_at":"2026-10-19T06:40:00.000Z","ends_at":"2026-10-19T08:00:00.000Z","location":"Аудиторія 101","url":"https://www.xelay.ink/groups/UUID?tab=schedule&date=2026-10-19"}
  ],
  "upcoming_truncated":false
}
```

The fixed window starts today in Kyiv and ends 14 days later, inclusively
(15 dates). All dates and end-time comparisons use the same server `v_now` as
`generated_at`. The server includes ongoing lessons and future occurrences only:
`(lesson_date + end_time) AT TIME ZONE 'Europe/Kyiv' > v_now`. A lesson ending
exactly at `generated_at` is excluded. Recurrence, week parity, semester bounds,
excluded dates, one-day lessons and copied Saturdays use the same stored schedule
and predicate as the legacy tomorrow list. No new access scopes are introduced.

Each dated group query is limited to 25 candidates, the combined candidates to
25, and the result to 24. Order is lesson date, start time, end time and row UUID.
`upcoming_truncated` is true when a 25th eligible occurrence exists. The UUID
identifies a schedule row and may repeat on different dates; use
`group UUID + lesson_date + lesson UUID` as the occurrence identity. Every URL
opens that occurrence's date on the same fixed HTTPS origin.

Clients classify a lesson as current when the exact `starts_at` instant is at or
before now and `ends_at` is after now. These UTC ISO instants retain seconds and
PostgreSQL's offset choice during the autumn Kyiv clock change. Do not reconstruct
them from minute-only display fields. The Android parser verifies that both
instants match `lesson_date` and the displayed HH:mm in `Europe/Kyiv`.
Recalculate this state and omit finished lessons on every redraw, including
redraws from cache; never use a fixed UTC offset. Local boundary
updates are needed when a lesson starts or ends, even without another network
response. An empty list means no eligible lesson in this bounded window. It does
not assert that the group has no later lessons. Refresh when the window becomes
stale, after manual refresh, and through the platform's allowed periodic work;
Android can delay background work.

The original `schema_version:1`, `schedule_date` (tomorrow), `lessons` (at most 12),
`deadlines` (at most five) and legacy `truncated` retain their existing meanings
and values for older APKs. `upcoming_truncated` is independent of legacy
`truncated`. Clients must tolerate missing upcoming fields while the server is
still on the base migration; legacy tomorrow lessons must not be mislabeled as
today's current lessons.

### Deadlines

At most five upcoming tasks are returned from three sources:

- `homework`: a dated group homework with text, links or attachments; a lesson
  topic alone is not an assignment. `due_date` is the lesson date and `due_at` is
  `null`. Cancelling the lesson does not silently delete retained homework.
- `long_term`: an unclosed shared group task with `due_date` today or later.
  Its date has no exact deadline time, so `due_at` is `null`.
- `teaching`: a published assignment in an accepted, unarchived course-group
  connection with an actual future `due_at`. Tasks already `submitted` or
  `reviewed` by this user are omitted; missing work, drafts and returned work
  remain eligible. Assignments without a deadline are omitted because their
  `due_date` cannot be truthfully supplied.

Ordinary homework and long-term tasks have no per-student completion marker in
the current schema. Present them as upcoming tasks, not as a verified list of
unfinished work. No personal organizer data, work contents, grades, attachment
paths, roster, or other students' statuses are returned. Overdue tasks are not
included in this first version.

Each source query is limited to six rows, the combined candidates to six, and the
result to five. Sort order is Kyiv date, exact deadline (if present), source and
UUID. On the same date, tasks without an exact time follow timed deadlines; this
sort convention does not create an implied midnight deadline. `truncated` is
true if either the lesson list or the combined deadline list was shortened.

All URLs are fixed-origin HTTPS links under `https://www.xelay.ink/groups/`.
Homework URLs open the existing dated assignment. Long-term and teaching tasks
currently open the group's schedule section; exact task deep links are not yet
supported. URLs carry no access token and do not grant membership.

## Errors and caching

- `AUTH_REQUIRED`, SQLSTATE `28000`: missing/inactive/unconfirmed account.
- `MEMBER_REQUIRED`, SQLSTATE `42501`: unknown/null group or no actual membership.

Never treat an authorization or network failure as an empty successful snapshot.
Cache by user UUID and group UUID, clear on logout/account change, and discard
private cached content after membership denial. Display `generated_at` as the
last refresh. On every redraw, recalculate tomorrow in Kyiv and do not present a
cached lesson list for a different date as tomorrow's schedule. The Android
companion uses system periodic updates and manual refresh; Android may delay
background execution, so exact midnight refresh is not guaranteed.

## Deployment

Applied to production Supabase **Xelay mvp** after the user's explicit approval.
Catalog verification confirmed both functions exist, return `jsonb`, use stable
read-only semantics and an empty search path, and can be executed only by
`authenticated` (not `anon`, `service_role`, or `PUBLIC`).

The Android debug-preview APK was assembled successfully. No automated tests or
physical-device validation were performed. The installation and grant checks do
not establish an end-to-end login/widget refresh result on a real phone.

The additive upcoming migration was applied to production **Xelay mvp** on
19 October 2026. Catalog verification confirmed the new fields, legacy format,
and the exact unchanged function ACL/settings. It only replaces the existing
snapshot function; it does not replace group selection or grant new permissions.
APK 0.1.2 was assembled successfully and its signing certificate matches 0.1.1.
No automated tests or physical-phone validation were performed for this release.
