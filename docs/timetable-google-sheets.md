# Timetable import from Google Sheets

The timetable importer accepts an ordinary Google Sheets URL, downloads its
current XLSX snapshot, and uses the same local spreadsheet worker and explicit
worksheet selection as a manually uploaded workbook. Course, group name,
programme, degree and per-source layout hints remain part of the existing
signed recognition package. No automatic recognition or schedule write occurs.

## User flow

1. Open the group's timetable import and enter the course/group search fields.
2. Paste an HTTPS `docs.google.com/spreadsheets/d/<id>/...` link (the ordinary
   `/spreadsheets/u/0/d/<id>/...` account variant also works).
3. Click **Завантажити за посиланням** and explicitly select the relevant sheets.
4. Set the same group-column/week hints as for a file upload, then analyze and
   review the recognized lessons. Choose dates and the upper-week anchor before
   transferring to the editable draft. Saving to the group stays a separate step.

The source must be readable without Google login and allow downloading. This
does not connect a Google account or request Google Drive access. A private or
download-restricted file requires the existing manual XLSX upload instead.
The importer never changes Google sharing settings.

The link fetches the whole workbook, even if the link includes `gid`. Google
worksheet IDs are not treated as XLSX sheet IDs; the user chooses sheets from
their displayed names. This is a snapshot, not a subscription or live sync.
Remove and reload it to pick up subsequent Google Sheet changes.

## Limits and access

- Link downloads: at most 4 MiB as binary, below the hosting function's 4.5 MB
  response limit. Manual local-file uploads retain their 8 MiB limit.
- Existing limits of 10 selected sources and the spreadsheet worker's sheet,
  cell, ZIP, expanded-byte and text limits are unchanged.
- The existing authenticated group schedule permission is checked before any
  Google request. No new database rights, Google credentials or AI quota grants
  are introduced. Downloading the link does not consume an AI attempt.
- A bounded process-local throttle limits repeated/concurrent downloads; it is
  best-effort across server instances, not a durable global quota.

## Server path

`POST /api/groups/recognize-timetable?xelay_timetable_route=google-sheet`
accepts only JSON `{group_id, google_sheet_url}`. It uses the existing function
slot; the seminar and recognition routes are preserved. The response is a
private, no-store XLSX binary with a fixed safe filename.

The server constructs a fixed Google export URL from a validated spreadsheet
ID and follows at most three manually checked Google export redirects. It
does not send Xelay authorization headers, cookies, arbitrary query parameters
or a referrer to Google. Login redirects and HTML pages are rejected. Both
declared and streamed response sizes are bounded; ZIP envelope checks precede
the existing disposable browser worker's full parsing and inflation limits.
User cancellation, group changes, URL edits and request deadlines discard late
responses instead of adding a workbook to the wrong group or stale draft.

References: [Google sharing](https://support.google.com/docs/answer/2494822),
[Google XLSX export format](https://developers.google.com/workspace/drive/api/guides/ref-export-formats),
[Vercel response size](https://vercel.com/docs/functions/limitations).
