# Platform news

## Scope and permissions

- A news post with `university_id = NULL` and `academic_unit_id = NULL` belongs to **«Новини платформи»**. It is readable by signed-in users, including profiles without an academic unit. Draft and archived posts retain editor-only access.
- A non-NULL university and NULL unit still mean university news. A non-NULL unit still means faculty news. A unit without a university is rejected by a database constraint.
- Platform administrators manage this feed with the existing ADMIN role, AAL2, a verified own MFA factor and an active auth account, checked by the new read-only self-capability `xelay_is_platform_news_admin()`. Catalog inspection found the installed base `xelay_is_platform_admin()` is role-only; it is preserved verbatim. This migration adds MFA only for new global administration, not for legacy university/faculty operations.
- Other users request **independent** platform editorial access with `xelay_request_editor_access(p_message, 'platform')`. Approval through the existing `xelay_review_editor_request(uuid,boolean)` grants only `PLATFORM_EDITOR`, with both scope IDs NULL. University and faculty editor roles never grant platform editing.
- The pending-request uniqueness index normalizes both NULL scope IDs, preventing repeated global applications. Applications and the administrator review interface retain existing private read rules.
- A restrictive SELECT policy lets users read their own platform applications and requires verified administrator MFA for other people's platform applications. The approval RPC repeats this check after locking the request. A narrow user-role trigger also requires verified administrator MFA for client-origin grants, recipient transfers, scope changes and revocations involving `PLATFORM_EDITOR`, including calls through older SECURITY DEFINER endpoints. Existing trusted backend maintenance remains permitted. Cleanup after the actual parent profile has been deleted may cascade without MFA; no access can be granted through that exception.
- Platform news has no user-suggestion/moderation workflow. `news_submissions.university_id` stays NOT NULL; ordinary faculty/university suggestions are unchanged.

The live catalog also lacks the local general `xelay_security_is_trusted_backend()` helper. This migration therefore creates its own private `xelay_platform_news_is_trusted_backend()`, used only by the two new global/role triggers. It inspects the requested database role and original `session_user`, never the owner `current_user` inside a SECURITY DEFINER call. Clients and `service_role` have no direct EXECUTE privilege on this helper; its owner can invoke it from the trigger. Existing backend maintenance is recognized from the actual connection role, not editable user metadata.

## Existing integrations

The migration extends the installed permission helpers and preserves their unrelated branches. Existing post RLS, private images and attachments, comments, likes, direct/group chat shares and edit/delete RPCs continue to use those helpers. Catalog inspection did not find a general news identity trigger on the live deployment, so a new trigger protects only global rows: ID and publisher are immutable, creation time is server-owned, crossing between global and academic scope is forbidden, and every client write/delete requires global management rights. Academic rows and any independently installed audit mechanisms remain unchanged. Platform editors can upload their own media even without a selected university; existing size limits and object-ownership checks remain.

A first publication creates the existing in-app notification and independent news unread receipt for each active profile. The server-only once-per-post publication receipt prevents announcements on edits or republishing. Deleted/banned auth accounts are excluded as before. **Global platform news deliberately does not enqueue notification email.** University/faculty notification preferences, delivery limits and email behavior remain unchanged. Installing this migration creates no posts and sends no announcements.

The client unread provider keeps recipient-owned notification queries and classifies NULL,NULL posts as `platform`; it must not require a university selection or treat NULL university as a university-scoped feed. It acknowledges only successfully displayed posts.

## Rollout

### Custom categories

Migration `202610220008_news_categories.sql` adds optional categories separately from the existing publication formats. An event can retain its event fields while belonging to a category such as «Для викладачів».

Editors and administrators create a category with **«+ Категорія»** in an authorized feed. Its chip appears in that feed, and the composer and editor offer it as an optional selection. Category names contain 2–50 characters. Repeating the same active name in the same scope returns the existing category. A category from a different platform/university/faculty scope cannot be attached to the post; the database checks this independently of the interface.

Migration `202610230002_news_category_archive.sql` adds reversible removal in **«Керувати категоріями»**. Custom categories are archived and can be restored; existing posts retain their category and stay in «Усі». The four standard category/filter chips can also be hidden and restored independently for each feed. Their underlying publication formats remain valid because event fields, historical posts and other existing behavior depend on `post_type`. Every change requires the exact feed's editorial access, with a scope-version check against concurrent edits. There is no client rename, cross-scope move or physical category-delete endpoint. See [Category archive](news-category-archive.md).

### Deployment order

1. Inspect the read-only catalog preflight in the workspace `artifacts/platform-news-preflight.sql`. All 16 function anchors and both photo-role array anchors must exist exactly once. The normalized installed administrator-helper fingerprint must match the inspected live helper, the pending index and both upload policies must exist, and the new constraint names and scoped helpers must be absent. The missing legacy trusted-backend helper is expected and safely reported as absent. The query returns schema metadata/counts and base64 definitions, not user records or secrets. The separate administrator/MFA catalog captures the existing security call chain and policies.
2. Review the local UI and obtain the required approval before installing new production server rights.
3. Apply `supabase/migrations/202610220007_platform_news.sql` as one complete transaction. It drops no news content, grants no editor automatically and installs no background job or paid service.
4. Apply any following category migration, then publish the matching client.

The migration is intentionally fail-closed on unknown function/constraint drift. The patch helper removes carriage returns from both the installed definition and its literal anchor, preserving clipboard CRLF compatibility. It uses `CREATE OR REPLACE` on inspected definitions so current ownership, function ACLs and unrelated hardening remain intact. Photo upload policies change only their existing editor-role array, preserving all bucket/path/metadata restrictions. A failed statement rolls back the whole transaction; do not continue individual fragments. A successful migration should not be reapplied manually.

No automated tests or build were run for this change. Schema preparation and static review are distinct from applying/validating the production migration.
