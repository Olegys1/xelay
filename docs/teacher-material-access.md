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

The server file broker invokes the metadata RPC with the viewer's JWT on every metadata/page/chunk request. Only after authorization does it use the existing backend credential to read the canonical private object in bounded ranges. Restricted viewers receive `render_mode: raster` metadata and authenticated WebP page responses with the viewer and author names already drawn into their pixels. A raw offset/length request with `download_allowed=false` is rejected before Storage is read. Download-authorized callers keep the source-range interface.

Access, source version and names are checked again after page preparation or a permitted source read and before sending the result. Revocation fails with 403; a changed source or identity fails with 409 instead of sending stale output. Responses use private no-store caching and never contain a signed source URL or backend credential. Existing assignments and submission-file access remain unchanged.

### Restricted page rendering

The renderer keeps at most two source documents in private worker memory for 120 seconds. It caches no personalized page responses. Each page is freshly marked for the current authenticated viewer, including when two viewers share the same source worker.

Workers receive no application environment variables. Source loading is bounded to 20 seconds; opening and rendering have separate 15-second termination limits. The queue admits at most 16 waiting jobs for at most five seconds. Busy responses use 429 with a short, bounded, cancellable client retry. These limits prevent an expensive file from holding an unlimited queue.

Pages have a maximum side of 2000 pixels, at most 3 million output pixels and a WebP response below 3.5 MiB. Image headers are checked before native decoding; decoded images and embedded PDF images are limited to 16 million pixels. Documents have at most 1000 pages. Restricted TXT/CSV over 2 MiB require a PDF version. An unsupported or failed render never falls back to sending the original.

The viewer reuses an already marked page when zooming, resizing or entering fullscreen. It blocks the ordinary canvas context menu, dragging and mobile touch callouts for restricted viewers. A source canvas remains hidden until its watermark is complete, preventing a clean intermediate frame.

## Honest browser limitations

This is an application access preference, not DRM. Restricted viewers receive personalized page images rather than the original PDF, image or text bytes. The platform removes its original-download action and keeps the private Storage boundary. A viewer can still capture or reconstruct those watermarked page images, take screenshots, record the screen or photograph it. Context-menu suppression is a convenience guard, not a security boundary; the source-file boundary is enforced on the server. Watermarks discourage redistribution but cannot prevent copying.

Previously issued legacy Supabase signed links may remain valid for their existing lifetime, up to **120 seconds**. Changing the flag or withdrawing a material cannot revoke an already downloaded copy or guarantee removal from a browser's existing memory/cache. Fresh broker requests check current access and withdrawal state.

## Consent compatibility

New publication/scheduling acceptance uses `2026-10-23.1`, matching the updated explanation of material access. The receipt constraint accepts both this version and historical `2026-10-21.1`; no prior acceptance is rewritten or backfilled. The scheduler still accepts previously scheduled unrestricted materials under the older version, while restricted materials require the latest version.

## Rollout and evidence

1. Read the live catalog using the workspace `artifacts/teacher-material-access-preflight.sql` and `teacher-material-scheduler-preflight.sql`. Confirm the installed author guard, private 50 MiB teaching bucket and actual function bodies.
2. Run the read-only `teacher-material-access-anchors.sql`: all **11 function anchors** and the **one consent-constraint anchor** must match exactly once. Confirm the new column and RPC do not already exist. The helper normalizes carriage returns symmetrically in live definitions and migration literals.
3. Apply `supabase/migrations/202610230001_teacher_material_access.sql` as one transaction. It uses a 5-second lock timeout and a 90-second statement timeout. A mismatch rolls back the transaction; do not run individual fragments after a failure.
4. Publish the matching editor, viewer/broker and material-terms update. Existing backend credentials stay in server configuration; no new service is purchased or credential created.
5. Read `artifacts/teacher-material-access-postflight.sql` to inspect the column default, constraints, trigger, narrow RPC/guard ACLs, raw-file gate, scheduler compatibility and private bucket. This query does not invoke a user RPC or run the scheduler.

The original migration and catalog scripts copy no teacher/student content and do not create test materials, requests or submissions. They do not change existing material versions, publication times, recipients or historical consent receipts.

The 2026-11-09 server-raster update requires no database migration. Publish the matching server, worker, traced native dependencies and client together; older restricted viewers must refresh instead of falling back to raw bytes. Synthetic regression tests cover raw-source denial, current account/file authorization, revocation during rendering, stale versions and names, bounded output, PDF/image/text rendering, different marked pixels for different viewers and authors, worker cancellation and fullscreen lifecycle.
