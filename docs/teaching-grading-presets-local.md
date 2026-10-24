# Teaching grading presets and work types — local implementation

Prepared on 2026-10-24 for the locally reviewed teaching feature batch. After user approval, migration 004 was applied with migrations 002 and 003 in one production transaction. Frontend publication is carried by the scoped academic-teaching release.

## Behaviour

- Course settings edit the existing category totals, coefficients and rounding, plus reusable work presets. A preset stores its label, semantic work type, maximum for one work, scoring category and submission format.
- Journal → **Правила та шаблони** allows the course manager to inherit the course rules or save a complete override for the selected accepted group.
- Group changes show how published student totals would change. Raw scores, publication state and grade history stay intact. Categories already used by the group's works/assignments cannot be removed, including when returning to inherited defaults.
- Assignment and journal editors apply presets only after an explicit dropdown selection. Choosing a preset fills the editor's work type, scoring category and maximum; assignment presets also fill submission format. Existing grades are not rewritten. The existing maximum-below-grade checks remain in force.
- Semantic work type is a separate field from written/oral/defense submission format and from scoring category. The type selector supports built-in labels and a teacher-defined label up to 100 characters.
- Student analytics and journal summaries expose the selected group's scoring system and work presets, including when no numeric score has been published yet. Group-specific effective rules feed student analytics, journal totals, CSV and XLSX.

## Formula retained

For each category, sum numeric raw scores, multiply by the category coefficient (default 1), cap at the category's semester maximum. Add uncategorized raw scores. Round the final sum once and enforce the overall maximum. An absent score remains unknown; zero remains a real score.

## Server contract, prepared only

Migration: `supabase/migrations/202610240004_grading_templates_and_work_types.sql`.

- Adds optional `presets` validation to existing grading rules.
- Adds `grading_rules_override` and independent `grading_version` to course/group links.
- Adds bounded `work_type` to teaching items and activities; legacy rows default to empty.
- `xelay_teaching_save_group_grading` requires current verified course management permission, active accepted group link, matching course version and matching group grading version. Saving/resetting an override checks categories of existing activities and all targeted items.
- Classified save wrappers require the actor captured when the editor opened, reauthorize against the active course and accepted group even for receipt replay, and delegate to canonical versioned mutations. Work type is persisted inside those mutations before receipt storage; exact replay has no side effects. Copies take work type from the same locked source snapshot as content.
- Existing category validation is patched to use effective group rules. Patches require exact expected fragments and abort the whole transaction on drift.
- The own-group RPC returns effective rules consistently in both course and own-grade projections. Existing membership checks remain unchanged. Staff course snapshots already project the complete group link row, including the new fields.
- No raw grade updates, broad table grants, external contact exposure, new public read endpoint or production data fixture is added.

## Local preview fixtures

The local teaching repository adds configurable Seminar 5 / Notes 1 / MKR 20 presets. Group 2 demonstrates its own seminar coefficient 1.5; Group 1 inherits course defaults. Local saves enforce management permission, accepted-group linkage, optimistic versions, rules validity, category retention and existing grade maximum guards.

## Review status

The local implementation was reviewed and approved by the user. Type checking and integrated preview inspection passed. Read-only production catalog checks confirmed the group override columns, work-type columns and trigger, RPC contracts and preserved original grade aggregates. No real grades were changed for acceptance checking. No automated tests or local production build were run; the deployment service builds the scoped release.
