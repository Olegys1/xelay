# Teacher material access

## Author controls and current audience

`teaching_items.allow_download` records the material author's choice about access to original attachments. Its non-null default is `true`, preserving existing publications and old clients. Only material rows may use `false`; assignments and student submissions keep their existing behavior.

Existing materials are edited through `xelay_teaching_mutate('save_material', ...)` using the same canonical item ID, version check and author identity. The installed author guard, active course and `materials` permission checks remain in force. A legacy edit that omits `allow_download` preserves the saved value. Group projections expose `can_edit` only for the author with an active course and current material permission; the existing own-material list already applies those rules.

Withdrawal continues through the existing author-only withdrawal endpoint, including when course access or verification has changed. Its update changes only withdrawal/version/time fields, so the new access trigger does not prevent withdrawing a material with missing or outdated resources. Every later file-view request rejects a withdrawn material.

## View-only resources

When original downloading is disabled, resources must be suitable for the platform viewer:

- PDF;
- JPEG, PNG and WebP images;
- plain TXT and CSV text;
- a retained CSV attachment with the legacy `application/vnd.ms-excel` MIME is accepted only when its storage path ends in `.csv`. XLS and XLSX are not accepted as view-only resources.

External resource links are rejected in this mode because Xelay cannot control downloads from another site. Other attachment formats require conversion to a previewable file or retaining original downloading.

The author must own the actual uploaded bytes and the attachment must use the material's course directory. An inherited attachment belonging to another author/course must be re-uploaded by this author before it can be restricted. Unrestricted historical references retain their existing read behavior.

The new trigger covers inserts and updates to kind, download choice, resources, publication status, consent version, author or course. Restricted published/scheduled materials require the latest material consent. Changing only `withdrawn_at`, version and update time does not invoke it.

Server errors used by the editor:

| Error | Meaning |
| --- | --- |
| `TEACHING_MATERIAL_PREVIEW_FORMAT_REQUIRED` | Convert an unsupported attachment to a supported preview format. |
| `TEACHING_MATERIAL_PREVIEW_LINKS_UNSUPPORTED` | Remove external resource links or permit original downloading. |
| `TEACHING_MATERIAL_PREVIEW_OWN_FILES_REQUIRED` | Upload the attachment from the material author's account in this course. |
| `TEACHING_MATERIAL_RIGHTS_REQUIRED` | Accept the current material terms before publishing/scheduling. |

## File authorization and private storage

`xelay_teaching_material_file_access(p_item_id uuid, p_storage_path text)` is available only to authenticated callers. It validates the current active account, the existing `xelay_teaching_can_read_item` permission, non-withdrawn material, exact attachment descriptor and actual private Storage object, including owner, MIME and size. It returns canonical metadata, version, author/viewer names and the two flags `allow_download` and `download_allowed`. It never returns a signed URL or a credential.

`allow_download` is the item's saved author preference. `download_allowed` also accounts for the author viewing their own resource and for every restricted reference to the same path. A different readable item must not reopen original-file access while any material protects those bytes from this viewer. The private Storage read helper applies that same path-wide restriction, including retained references on withdrawn materials. Ordinary prior read checks remain required even for the author.

The server file broker invokes the metadata RPC with the viewer's JWT on every metadata/chunk request. Only after authorization does it use the existing backend credential to read the canonical private object in bounded ranges. The response is uncached; no public bucket, new role, public audience, persistent credential or signed client URL is introduced. Existing assignments and submission-file access remain unchanged.

## Honest browser limitations

This is an application access preference, not DRM. The platform removes its original-download action for restricted viewers, keeps the private Storage boundary and displays a viewer watermark. The browser still receives bytes necessary to display a resource. An authorized viewer with technical tools can reconstruct those preview bytes; screenshots, screen recording and photographs also remain possible. Watermarks discourage redistribution but cannot prevent copying.

Previously issued legacy Supabase signed links may remain valid for their existing lifetime, up to **120 seconds**. Changing the flag or withdrawing a material cannot revoke an already downloaded copy or guarantee removal from a browser's existing memory/cache. Fresh broker requests check current access and withdrawal state.

## Consent compatibility

New publication/scheduling acceptance uses `2026-10-23.1`, matching the updated explanation of material access. The receipt constraint accepts both this version and historical `2026-10-21.1`; no prior acceptance is rewritten or backfilled. The scheduler still accepts previously scheduled unrestricted materials under the older version, while restricted materials require the latest version.

## Rollout and evidence

1. Read the live catalog using the workspace `artifacts/teacher-material-access-preflight.sql` and `teacher-material-scheduler-preflight.sql`. Confirm the installed author guard, private 50 MiB teaching bucket and actual function bodies.
2. Run the read-only `teacher-material-access-anchors.sql`: all **11 function anchors** and the **one consent-constraint anchor** must match exactly once. Confirm the new column and RPC do not already exist. The helper normalizes carriage returns symmetrically in live definitions and migration literals.
3. Apply `supabase/migrations/202610230001_teacher_material_access.sql` as one transaction. It uses a 5-second lock timeout and a 90-second statement timeout. A mismatch rolls back the transaction; do not run individual fragments after a failure.
4. Publish the matching editor, viewer/broker and material-terms update. Existing backend credentials stay in server configuration; no new service is purchased or credential created.
5. Read `artifacts/teacher-material-access-postflight.sql` to inspect the column default, constraints, trigger, narrow RPC/guard ACLs, raw-file gate, scheduler compatibility and private bucket. This query does not invoke a user RPC or run the scheduler.

The migration and catalog scripts copy no teacher/student content and do not create test materials, requests or submissions. They do not change existing material versions, publication times, recipients or historical consent receipts. Static review, catalog inspection and type checking are separate from automated tests/builds; no automated test or build was run for this work.
