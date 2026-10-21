# Teacher materials: server contract

Prepared migration: `supabase/migrations/202610210001_teacher_materials_projection_withdrawal.sql`.
Applied to **Production Xelay mvp on 21 October 2026** by the root release task,
after its read-only prerequisite and exact-anchor preflight. Supabase SQL query
`0003289a-fc08-439c-8031-4669755198ca` returned `Success. No rows returned.`
The applied `001` source is preserved; later assignment binding is a separate `002` migration.

## One publication, two views

The canonical record stays in `teaching_items`, with `kind='material'`. Its
`created_by` is the publisher account, rather than a claim that the account owns
every intellectual property right in the content. Audience rows remain in
`teaching_item_targets`; files remain in the private `xelay-teaching-files` bucket.
No material rows, links or file bytes are copied into study-group storage.

`xelay_group_teacher_materials(p_group_id uuid)` returns:

- `subjects`: subject metadata for the returned publications.
- `materials`: existing `TeachingPublication` JSON, plus `source='teacher'`,
  `source_item_id`, `group_id`, `subject_id`, `subject_name`, `course_title`,
  `course_archived_at`, `read_only=true` and `can_withdraw`.

Only an actual representative or accepted group member may call this projection.
Only published, nonwithdrawn materials explicitly targeted to that group through
an accepted course/group link appear. An archived course remains readable, as in
the existing teaching views. A removed group link stops subsequent group reads
and new file signing for that student audience.

The course's selected `subject_id` references the **seminar** subject directory.
It is never used as a materials-subject UUID. The projection joins a materials
subject only when its canonical name has exactly one match in that group. It
otherwise returns a virtual subject ID, `teacher-subject:<seminar-subject-id>`;
without a seminar binding, the course ID and course title supply that fallback.
Virtual subjects have `source='teacher'`, `virtual=true`, `read_only=true` and must
not be offered to local material create/rename/delete actions. This is display
grouping; no new subject or writable mapping is inserted.

The returned files keep the teaching descriptor format
`storage_path/name/mime_type/size`. Open them through the teaching file repository,
never the group-material bucket. Attribution comes from the original
`created_by`, `author_name` and `course_title` and is displayed as “Від викладача”.

## Author actions

`xelay_my_teaching_materials()` returns `{materials:[...]}` for the authenticated
publisher, including drafts and withdrawn records, with `course_title`,
`course_archived_at`, `withdrawn_at`, `can_withdraw` and `can_edit`.
It does not require current teaching verification, accepted group links, course
ownership or course permissions. Normal account authentication still applies.

Use the existing dispatcher:

```text
xelay_teaching_mutate('withdraw_material', {id, version})
-> {id, version, status:'withdrawn', withdrawn_at}
```

This checks the stored `created_by`, locks the course and item in their normal
order, and checks the expected version. It does not call the archive/permissions
gate for editing a course. An exact retry after a lost response is idempotent.
The legacy `delete_material` action uses this same withdrawal path.

Withdrawal marks the one canonical source with `withdrawn_at`; it does not delete
assignments, activities, grades, submitted work or student files. Withdrawn source
content cannot be edited, republished, or read through normal course/group views.
The author can still inspect the withdrawal record in My materials. The existing
file read helper uses the corrected item visibility, so it cannot issue a new
signed URL through a withdrawn material. The source row and private original
bytes remain retained rather than being physically erased by this action.

The table trigger also protects author identity and rejects colleagues, students
and representatives editing or deleting another publisher's material. Ordinary
editing of one's own material still requires the existing `materials` permission
and an active course. Newly attached material files must match the publisher's
path and actual Storage object owner; a missing owner fails closed. Exact retained
descriptors from older sources remain readable under their existing access rules.
Assignment and grading authorization is preserved.

## Publication acceptance

Every `save_material` whose resulting payload status is `published` must include
the actual JSON boolean `rights_accepted:true` and
`rights_terms_version:'2026-10-21.1'`. This includes edits that keep an existing
material published. A draft save or withdrawal does not require acceptance.

Successful publication records `rights_accepted_by`, `rights_accepted_at` and
`rights_terms_version`. Existing records keep NULL acceptance fields until the
publisher really accepts on a later publication; there is no consent backfill.
These fields record the latest actual acceptance rather than a complete event
history. The shared item serializer removes all three receipt fields for anyone
other than the publisher, including students and course colleagues. The publisher
can inspect their receipt in My materials. The client links to
`/terms#teacher-materials` and starts each publication confirmation unchecked.

## Revocation boundary

Automatic display uses the original source; future `copy_course` calls copy only
assignment templates, preventing automatic material copies with a different
publisher. Existing independent publications are not retrospectively relabeled,
deleted, or assigned invented provenance.

Teaching file URLs already issued by the client expire after 120 seconds. A
withdrawal stops subsequent source reads and signing after commit; it cannot
invalidate an already issued URL before that expiry, erase a downloaded file, or
control the availability of an external link. No DRM or physical deletion of all
copies is promised. A file separately attached to an assignment or another
independent source keeps that source's existing access rules.

## Preparation boundary

The migration preserves direct-table ACLs, existing storage policies and the
dispatcher signature. New public RPCs are authenticated read projections. Private
withdrawal and trigger functions have no browser EXECUTE grant. Existing
dispatcher patches are exact-match guarded, so an unexpected prerequisite aborts
the transaction. No tests or builds were run by the server implementation task;
production application was performed separately by the authorized root release task.
