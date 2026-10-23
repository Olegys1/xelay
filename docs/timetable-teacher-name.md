# Teacher display names in group timetables

Migration: `202610230003_timetable_teacher_name.sql`.

## Data and access

`study_group_schedule.teacher_name` is optional plain display text, stored as a
non-null string with a blank default. It is not a reference to a user, verified
teacher status, course owner or personal calendar assignment. Adding a name
does not invite that person or grant any access.

The existing schedule read policies, representative/deputy schedule permission,
membership checks, write lock and immutable row identity stay in place. No
table privilege or public RPC execution grant is added. The normalization
trigger function has no client execution permission and no elevated privilege.

Names support up to 180 Unicode characters after trimming and collapsing spaces.
ASCII/C1 control characters and Unicode directional override/isolate characters
are rejected before normalization. Blank input or an explicit null clears the
name to `''`; an old client that omits the column on an update retains its value.
Existing rows receive the blank default; no teacher name is inferred or copied
from profile data.

## Creation, import and copies

Direct lesson creation and editing save the field through the existing table
API. The atomic timetable import also accepts an optional string/null
`teacher_name`. Omission gives a newly inserted row a blank name. The importer
does not update existing rows, and retains its existing duplicate rejection:
changing only the display name cannot create a duplicate of an otherwise
identical overlapping lesson or silently overwrite its saved name.

Day copies in both original and first-shift time modes retain the name. Source
deduplication and destination comparisons include it, including the first-shift
projection. A destination with otherwise identical content but a different
teacher name is a conflict rather than a skipped duplicate. Existing overlap
checks remain in force. Copying a sequence delegates to these same day-copy
functions, and cancelling an occurrence changes only `excluded_dates`.

Copy preview signatures already include complete source row JSON, so changing
only a teacher name invalidates a stale preview. An open preview made before
the migration also needs to be refreshed because the new field changes that
JSON shape. No additional authorization is derived from a signature or name.

Weekly repetition stores the name on the schedule series. Separate upper/lower
rows can retain different names. Academic subject/seminar projection identities
continue to use their existing subject/source keys; this field does not create
or rename a seminar or a teaching subject.

## Read projections

Existing `select('*')` schedule reads and complete-row copy previews include the
new field automatically. The existing Android widget snapshot and teaching
calendar JSON projections also receive an additive `teacher_name` field under
their unchanged authorization and recipient checks. A standalone manual seminar
calendar row has a blank name, because it does not have this schedule field.
Existing widget clients may ignore the additive JSON field; no APK/iOS build is
part of this change.

## Rollout and source checks

1. Read the installed catalog with
   `../artifacts/timetable-teacher-name-preflight.sql`. It exports definitions as
   base64, metadata, ACLs and counts, without lesson content or executing RPCs.
2. Compare the installed functions using
   `../artifacts/timetable-teacher-name-anchors.sql`. All 29 old anchors must
   match exactly once, and the column and new trigger function must be absent.
3. Apply the migration as one transaction before deploying the client fields.
   It has a 5-second lock timeout and a 90-second statement timeout. It patches
   installed definitions with strict CR-normalized anchors, preserving function
   owners, ACLs and unrelated guards. An unexpected definition aborts the entire
   transaction instead of replacing it with a historical local implementation.
4. Read `../artifacts/timetable-teacher-name-postflight.sql` and compare owners,
   ACLs, policies and schedule row count against the preflight. Check the new
   constraint/trigger, private trigger ACL, six patched functions and additive
   JSON fields. This query does not change schedules or execute user RPCs.

Before client deployment, the schema remains compatible with the existing
client. For a UI rollback, deploy the previous client while keeping the additive
column and server preservation rules; do not discard entered names. Removing
the schema later would require first preserving names and restoring the exact
pre-migration function definitions. There is no destructive automatic down
migration.
