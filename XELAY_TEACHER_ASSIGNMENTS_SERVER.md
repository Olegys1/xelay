# Teacher homework in the group timetable

Migration: `supabase/migrations/202610210002_teacher_assignment_lesson_projection.sql`.
Applied to **Production Xelay mvp on 21 October 2026**, after the applied
teacher-material migration `202610210001` and the existing classroom/timetable
occurrence migrations. The live read-only preflight found all five patch anchors
exactly once, with the occurrence helper present on PostgreSQL 17.11. Supabase
SQL query `e231d183-2344-4d20-9dd7-6ce48d7fd53c` returned
`Success. No rows returned.` No student work or grades were changed by deployment.

## Source and placement

Homework stays an original `teaching_items(kind='assignment')` publication with
its `teaching_item_targets`, submissions, history, activities and grades. No
`study_group_homework` rows or seminar assignments are inserted or updated.

Each group target gains three optional columns:

- `lesson_date`: an explicit calendar date, independent of its deadline.
- `schedule_item_id`: the chosen ordinary `study_group_schedule` slot.
- `placement_mode`: `lesson`, `unplaced` or NULL for legacy/unconfigured records.

Every new or edited published assignment must explicitly choose a mode in each
target payload. Drafts can remain incomplete.

`lesson` requires both date and slot. The server checks that the target group is
accepted for the course, the course has an explicitly selected seminar-subject
reference, the actual timetable slot belongs to that group and matching canonical
subject name, and the date is within the course semester and the slot's recurrence.
Cancelled dates are rejected. Multiple matching slots are never guessed.

`unplaced` is the explicit “Без прив’язки до пари” choice. It requires no slot and
at least a lesson date or deadline. An explicit lesson date must fall within the
course semester; deadline behavior keeps the existing assignment/assessment rules.
The course may have no subject binding or structured group timetable. This mode
lets those groups receive teacher homework without inventing a pair.

Example target:

```text
{group_id, due_at, placement_mode:'lesson', lesson_date:'2026-10-23', schedule_item_id}
{group_id, due_at:null, placement_mode:'unplaced', lesson_date:'2026-10-23', schedule_item_id:null}
```

Existing `save_assignment` and classroom `save_group_assignment` actions persist
these target fields. Group-specific forks retain them while keeping student work
and grade history attached to the canonical fork as before. A copy to a different
group starts as an unplaced draft and needs an explicit publication choice.

## Read RPCs

`xelay_teaching_assignment_lessons(p_course_id,p_group_id,p_lesson_date)` returns
`{subject_name, lessons:[...]}`. Only a teacher with the course's `assignments`
permission and an accepted course/group link may use it. Returned lessons are the
actual ordinary timetable rows for the selected subject/date, including their
times. If the course has no subject binding, the client offers standalone mode.
The save action rechecks the chosen pair rather than trusting this earlier list.

`xelay_group_teacher_assignments(p_group_id,p_lesson_date)` returns
`{assignments:[...]}` to the actual representative or an accepted group member.
It includes only published sources targeted through a currently accepted group
link, with the original teaching resources and attribution plus:

- `source='teacher'`, `source_item_id`, `read_only=true`.
- `group_id`, `subject_id`, `subject_name`, `course_title`, `course_archived_at`.
- `lesson_date`, `schedule_item_id`, `placement_mode`, `author_verified`.

The projection includes targets on the selected explicit date. A standalone target
with no lesson date appears on the Kyiv date of its deadline. Legacy targets with
NULL placement mode remain visible in the unplaced block, without guessing a pair.
Archive reads retain the existing behavior. Removed course/group links stop new
student reads. `author_verified` is the author's current verification state; it
does not fabricate a verification event for an older publication.

The client renders a blue teacher-source card under the exact visible pair only
when its ID, date, subject and occurrence still match. It otherwise keeps the
returned source in a compact “Поза парами цього дня”/legacy section. Opening
“Моя робота” uses the original item/group in the existing classroom pipeline.
Representatives receive no ability to edit the teacher source.

## Timetable changes and concurrency

The slot FK is group-scoped. Deleting a timetable slot clears only
`schedule_item_id`, preserving the target's explicit date and every source/work
record. Rename, recurrence changes or cancellation do not move or delete the
assignment. Day projection intentionally returns these invalidated placements;
the client must display them outside the current pairs until a teacher explicitly
chooses another placement.

Assignment saves serialize selected group checks with the existing timetable
advisory lock. Multi-group validation locks groups in ID order. A classroom save
locks course, then group timetable, then course/group link and source/target rows.
This also avoids waiting for a timetable/subject writer while holding its target
or selected-subject FK row. Direct academic-table write privileges remain revoked.
No new trigger or permission grants a teacher seminar distribution powers.

## Preparation checks

Dispatcher/classroom patches use exact-match prerequisite checks and abort the
whole transaction on an unexpected installed body. Item JSON retains the material
consent receipt redaction from `001` while exposing placement only to already
authorized audiences. The server task performs static inspection only: no SQL,
tests, builds, production access or deployment is executed here.

Five old anchors are expected exactly once each in the installed chain after
`202610180004` and `202610210001`: the dispatcher target loop, its accepted-link
check, its target insert/select, the classroom group-lock/payload boundary, and
the fork's single-group target insert/select. Earlier migrations do not modify
these blocks. Group-specific forks copy only that target's placement; source
targets for other groups retain their existing content and metadata.
