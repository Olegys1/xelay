# Teacher and group seminar boundary

Teacher classrooms contain assignments, materials and the gradebook. Student
question allocation, teams, reservations and seminar editing belong to the group
and its headman; teaching permissions do not grant access to these records.

Migration `202610240005_teacher_seminar_boundary.sql` closes the historical teacher
read/write facades, strips planning data from course responses and blocks new
activity links to student seminar planning. Existing activity links and grades
remain intact. Member/headman RLS and teacher calendar metadata are unchanged.

Applied to Xelay mvp on 24 October 2026. Receipt:
`400a14c0-fbcd-4ee8-8563-33947560b35b`.
The transaction verified unchanged seminar/grade counts and published grade sum,
unchanged membership predicate/calendar definitions and closed teacher facades.
TypeScript checking passed. No automated tests or production data edits ran.
