# Timetable recognition: groups, sources and week rows

## Limits and request flow

- Up to **10** image/spreadsheet sources in one package.
- Each image is at most **2 MiB**; all decoded images together remain at most **3 MiB**.
- The complete JSON request remains at most **4.25 MiB**, including base64, tables, hints, selection and token. This stays below the existing Vercel request limit; adding sources does not increase the byte budget.
- Spreadsheet text remains bounded to 180,000 characters across the package.
- The existing analyze → choose candidate → extract → review draft flow remains. Recognition does not write timetable rows.
- Existing authorization, daily quota, models, provider endpoint, timeouts and output-token caps remain unchanged. Each analyze/extract reserves its existing quota before one provider request; no additional model calls were added.

## Source hints and clarification

Both image and spreadsheet sources accept optional `layout_hint`. Older requests receive canonical defaults during normalization:

```json
{
  "group_columns": "auto",
  "group_column_count": null,
  "group_column_index": null,
  "week_rows": "auto",
  "notes": ""
}
```

`group_columns` is `auto`, `shared` or `split`. Split requires 2–6 outer group blocks and a selected 1-based index within that count. Group positions are measured **inside each day block**. For example, selecting the right group in a two-group timetable repeats that selection inside Monday, Tuesday and the other day panels. It must not crop the right half of the whole image and lose weekdays. Inner room/type/teacher/subgroup columns do not increase the group count. If group order changes between days and cannot be represented consistently, request clearer headings or separate day-panel crops.

`week_rows` is `auto`, `upper_lower`, `lower_upper` or `none`. Upper/lower order describes horizontal halves **inside one day/pair cell**, not consecutive pair rows. `none` says a horizontal division is not week parity; it does not establish weekly repetition. A whole undivided cell can retain an explicit printed upper-only/lower-only restriction through visible-legend evidence.

Notes are normalized text, at most 400 characters. All hints, notes, filenames, spreadsheet text and image text remain untrusted data. They cannot execute instructions, override contradictory visible labels or invent a missing group name. Target group/course/program fields remain user search criteria, not printed source evidence. The actual authenticated group ID and schedule permission continue to control access.

Analysis may return up to 20 `clarifications`, each with source index, kind (`group_columns`, `week_rows`, `source_identity`, `readability`) and a question of at most 300 characters. Any blocking question forces `layout: "unreadable"` and no candidates, including if a provider also returned a guessed candidate. Users adjust the relevant source hint/context or upload a clearer source, then analyze again. Extraction/preflight errors may also carry these questions and `requires_analysis: true`.

Clearly separated unnamed left/right group blocks may be selectable positional candidates with empty group names. Several unnamed sources are not assumed to be the same group because of equal positions, colors or similar subjects. They need visible continuation or consistent explicit user context. Unknown group identity remains visible as a review warning.

## Private source checks

The provider's analysis includes private `source_regions`: source index and outer group index/count for each contributing source. The server validates them against source hints and signs compact regions together with the exact candidate descriptor, authenticated user, destination group, normalized package fingerprint and 15-minute expiry in a **v3 analysis token**. Regions are not public candidate fields. Changed files, ordering, hints, notes, target criteria or candidate invalidate the old selection. Existing v2 tokens require fresh analysis.

Extraction receives only the selected signed regions. Each lesson must include private `source_evidence` with source index, outer group index, week pattern, parity basis and horizontal-row position. Before returning the public draft, the server checks that:

- Evidence stays inside the selected source/group region and agrees with explicit source hints.
- Uncertain parity blocks extraction; horizontal position or color alone does not establish upper/lower weeks.
- An `every` lesson has explicit every-week evidence or evidence for both upper and lower weeks. One upper-only source cannot establish weekly repetition.
- Confirmed upper/lower halves preserve alternating-week mode. A visible single-week restriction on a whole cell is retained without inventing a divided row.
- A clearly undivided cell without a parity legend is marked for review of weekly repetition.
- Public day/pair/time/cell-conflict validation, exact source identity matching and date/count review guards still pass.

Private regions and lesson evidence are removed from the public result. These checks validate the model's declared source mapping and user hints; they do not independently prove that every pixel was read correctly. The representative still reviews the draft before saving.

## Verification scope

Implementation review was static. No paid recognition request, live source-image trial, test suite, build, production configuration change or database mutation was run for this change. Recognition quality on the reported photos remains unmeasured.

The strict response schemas keep every property required and `additionalProperties: false` on every object, with supported scalar/array bounds. See the [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).
