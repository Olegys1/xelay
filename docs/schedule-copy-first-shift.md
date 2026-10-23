# Weekend copy times

The default **Залишити як у вихідному розкладі** option copies the source's
exact clock times, including second-shift lessons. Only explicitly selecting
**Перенести на першу зміну** projects the copy to the morning slots.

After migration `202610230004_schedule_copy_first_shift_order.sql`, distinct
source intervals are sorted by start/end time and assigned consecutive slots:
08:00–09:20, 09:40–11:00, 11:20–12:40, 12:50–14:10, 14:30–15:50.
Old lesson numbers, duplicate numbers and gaps no longer prevent a valid day
from being previewed. Parallel lessons with the same original interval remain
parallel. A user can still explicitly change the reviewed destination numbers
to retain a deliberate gap. There are still only five first-shift intervals.

Both one-day and weekly-sequence copies use the same private projection. The
source timetable, homework, teacher names and existing dated seminar work are
untouched. Copy preview, explicit confirmation, permission checks, source
signatures, deduplication and conflicts with existing destination lessons stay.

## Release order and compatibility

Apply the migration after `202610230003_timetable_teacher_name.sql`, then
publish the explanatory client text. Public RPC signatures and grants do not
change. The previous frontend remains compatible. A previously open preview
must be refreshed if its generated mapping changed; the existing source digest
rejects confirmation of an outdated preview. An explicit old mapping continues
to be valid because it was deliberately supplied by the client.

The schedule copy and ordinary schedule-edit code have no global 08:00 cutoff.
Seminar work and student reservations separately lock at that seminar's actual
start time. The reported failure to move a Saturday lesson has not been
reproduced from a concrete error or affected group/date; this change removes a
confirmed unnecessary first-shift numbering restriction, without claiming that
it explains that incident or reopening completed student reservations.
