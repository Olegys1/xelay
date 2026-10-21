# Personal grade analytics

The group's **Мої бали** button opens an overview of all accepted subjects in
the currently selected study group. A selected subject starts its detail view.
Subjects and semesters retain their course IDs, including archived courses.

## Source and privacy

The existing `xelay_teaching_group(groupId)` projection supplies the viewer's
published grades and accepted courses. Its server checks membership, the
accepted course/group connection, the exact linked account and publication.
The personal overview uses this projection for students, representatives and
teachers alike. The teacher's editable class journal remains separate.

No new database RPC, policy, grant or migration is required. The local repository
mirrors the own-only projection instead of returning a teacher's full snapshot.
UI data is keyed by both group and account, and late load responses are ignored.

## Calculations

- A published numeric zero is a result. A missing or comment-only score is
  unknown and stays distinct from zero.
- Subject totals apply the existing category caps and configured overall cap.
- Semester progress has a denominator only when a positive overall maximum is
  explicitly configured; the UI does not assume a 100-point scale.
- Performance on assessed work is the sum of numeric published scores divided
  by the sum of maxima for those same works. Across subjects this is a weighted
  result on assessed works, rather than a university GPA or semester forecast.
- Recent results are current published values sorted by publication date.
  They do not represent the historical sequence of grade revisions.
- Duck mood uses assessed-work performance: at least 80% smiles, from 50% to
  below 80% is calm, below 50% is sad, and unknown performance waits.

The isolated local preview at `?view=grades` uses explicitly fictional in-memory
data. It covers multiple subjects, an archive, a category cap, zero points and
comment-only feedback without changing the regular preview's persisted data.
