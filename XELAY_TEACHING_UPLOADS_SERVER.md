# Teacher and student work uploads

Compatibility migration `supabase/migrations/202610210003_teaching_upload_preflight.sql`
was applied to Production **Xelay mvp on 21 October 2026**. Supabase SQL query
`d6af530b-e18d-498a-8ce5-1db02b94dff7` returned `Success. No rows returned.`
It keeps the existing 20 MiB bucket and resource-validation limits.

Size migration `supabase/migrations/202610210004_teaching_upload_50mib.sql`
was also applied to Production **Xelay mvp on 21 October 2026**. Supabase SQL
query `c707b045-3ff7-41ae-aec4-e5f0599fff9b` returned
`Success. No rows returned.` A successful policy migration alone does not
confirm a real file upload.

## Why the upload failed

The old INSERT policies required `metadata.size`. Supabase Storage checks upload
permission before accepting bytes. Its current uploader passes
`metadata: {mimetype, contentLength, ...}` to that check, so `size` is absent at
this point. A valid authorized upload therefore failed the RLS check.

Source: [Supabase Storage uploader](https://github.com/supabase/storage/blob/master/src/storage/uploader.ts),
`canUpload` / `testPermission`. Earlier preflight variants may omit metadata.
The final Storage object metadata remains the authority for publishing a file.

## Scope and limits

At the user's explicit request, teacher course files (`xelay-teaching-files`)
and student work files (`xelay-submission-files`) accept up to
**50 MiB per file (52,428,800 bytes)** after migration `004`. The UI labels this
“50 МБ”. Both buckets stay
private, keep their exact existing MIME allowlists, and retain the existing
ten-file publication limit. Ordinary group homework, seminar resources and
other buckets are unaffected.

The project-wide Supabase Storage upload limit is currently 50 MB with the
spend cap enabled. The user chose to use the existing limit now. The
previous 180 MiB request remains deferred because raising the global limit
would require disabling that cap. Neither migration changes the global limit,
spend cap, plan or payment settings.

## Authorization and validation

Exactly four existing INSERT policies are altered in place. Their existing
upload authorization predicates still decide who may upload and to which
course or reserved student work. The supported filename extensions remain
restricted independently of metadata availability.

At the permission preflight only, absent metadata or absent metadata fields do
not reject an otherwise authorized upload. If supplied, MIME must match the
extension. The final `size` must be a JSON number of whole bytes between 1 and
the applicable per-file ceiling (20 MiB after `003`, 50 MiB after `004`). Supplied
`contentLength` must be a positive whole JSON number. It can include a multipart
request envelope, so `004` removes the initial `003` comparison of request length
with the file-size ceiling. Actual file bytes remain limited by Storage and the
resource validators. JSON null, incorrect types, fractions, zero and oversized
supplied final file sizes fail closed. Non-object metadata is rejected.

This does not treat a preflight as a saved publication. Storage still enforces
the private bucket's file-size and MIME limits while receiving bytes. The
installed teacher/student resource validators still require an actual object
and check its owner, path, final MIME and final size before linking it. Migration
`003` does not alter them. Migration `004` changes only their single numeric
20 MiB upper bound to 50 MiB; their current function bodies, including later
fixes, are preserved.

No new helper function, browser RPC, execution grant, reader, signed URL scope,
overwrite/upsert action or delete action is added. RLS remains enabled. Draft
student files remain private to that student until the existing submission
workflow makes the handed-in version available to authorized teachers.

## Atomic drift checks

Migration `003` takes short locks and aborts before changing anything if:

- Storage object RLS or existing upload predicates are absent.
- Either bucket is public, has a changed 20 MiB starting limit, or a changed
  MIME allowlist.
- Any of the four policies has a different command, permissive/restrictive
  mode, role set, USING clause or WITH CHECK expression. Only whitespace is
  ignored when matching the captured installed expressions.

Only after every check passes are the four upload policy expressions altered.
Bucket limits and resource validators are unchanged by this compatibility fix.

Migration `004` separately checks the same private buckets and MIME allowlists,
the policy command/role/mode boundaries, the post-`003` metadata gate shape and
exactly two 20 MiB constants in each policy. It reads each installed policy,
removes exactly one request `contentLength` upper-bound expression, and raises
the remaining final `size` bound to 50 MiB, retaining the rest of its expression.
It checks each installed validator is SECURITY DEFINER and has
exactly one original size-bound anchor, then changes only that anchor.
All checks pass before any mutation. Both bucket ceilings, both validator
ceilings and all four policy size ceilings change together in one transaction.

An unexpected failure rolls its transaction back. These are ordered migrations,
not rerunnable repair commands; an already-updated installation will fail the
old-state checks. No new SQL `005` or 180 MiB migration is prepared.

No application build, tests or production file write was performed by the SQL
preparation task. Existing larger files must be considered before any future
reduction of these limits.
