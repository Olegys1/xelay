# Reversible news category removal

## What changes

Custom categories gain `archived_at` and a positive row version. Removing a category archives it; restoring clears the timestamp. The same category ID and name remain available for historical publication badges. No news post is deleted, reclassified, archived, hidden from «Усі», or marked read by this operation.

The four existing standard chips correspond to the `post_type` formats `news`, `event`, `opportunity` and `announcement`. Those formats cannot simply be deleted: existing posts and event-specific field validation depend on them. Their removal is therefore a reversible **per-feed filter visibility** setting. Hiding «Подія» does not delete events or remove their dates, and never changes the `post_type` constraint.

Custom archive state belongs to the category's existing exact scope. Standard filter state belongs to the private `news_category_scopes` table. University/faculty state and platform state are separate, including when their labels happen to match.

## Permissions

Every archive, restore and category creation calls the existing `xelay_can_manage_news(university_id, academic_unit_id)` authority. Scope comes from the supplied scope IDs and is checked against the selected category row before any update:

- `(NULL, NULL)` means platform news. Its separately granted `PLATFORM_EDITOR` role or the existing verified-MFA platform administrator capability is required.
- `(university ID, NULL)` means university news and requires that exact university's editorial authority or administrator access.
- `(university ID, unit ID)` means one faculty/institute. Its exact editorial authority or administrator access is required.

A faculty/university editor never inherits platform editing. Client role booleans are not accepted as permission evidence. A category UUID from another scope cannot be archived through an otherwise authorized feed.

The public settings getter follows the existing category SELECT audience: signed-in platform readers, matching university/unit profiles, or exact authorized editors. The private settings table has RLS and no direct client privileges. Its operator ID/time are not returned. Category table SELECT remains as before; no direct client INSERT, UPDATE or DELETE privilege is added.

## RPC contract

`xelay_news_category_settings(p_university_id uuid, p_academic_unit_id uuid)` returns:

```text
{
  categories: [{id, name, university_id, academic_unit_id, archived_at, version}],
  hidden_types: ["news" | "event" | "opportunity" | "announcement"],
  version: scope version
}
```

The getter performs no writes. A scope without saved settings has version zero and no hidden standard types. All custom categories, including archived ones, are returned for old post labels and safe retention when editing an existing post.

`xelay_set_news_category_visibility(p_university_id uuid, p_academic_unit_id uuid, p_category_id uuid, p_post_type text, p_hidden boolean, p_expected_version integer)` requires exactly one of `p_category_id` and `p_post_type`. `p_hidden=true` archives/hides; `false` restores/shows. It returns the full settings object above. The expected version is the **scope** version, not the category's row version.

Every actual visibility change increments the scope version. Custom archive/restore also increments that category's row version. A request for the already-current state with the current expected version is a no-op. A stale version raises `NEWS_CATEGORY_CONFLICT` (`40001`); the interface reloads and asks the editor to review/retry instead of silently undoing another editor's action.

The existing create-category RPC also locks this scope. A new category increments the scope version; repeating an active name remains idempotent. Repeating an archived name raises `NEWS_CATEGORY_ARCHIVED`, prompting explicit restoration rather than silently bringing it back. The existing case-insensitive unique name index remains intact.

## Existing publications and races

New posts and changed category assignments may use only active categories in the exact publication scope. Existing post edits can retain their unchanged archived category ID in its unchanged scope, or remove it. Removing a category from a post does not allow reattaching that archived category until it is restored.

The post-category guard locks the exact category row `FOR SHARE`; archiving/restoring holds its row for update. This serializes new assignments with archive changes. Category creation and visibility changes share a scope-first lock order, with the existing name lock below it. No visibility operation locks or rewrites news post rows.

## Rollout

1. Inspect `artifacts/news-category-archive-preflight.sql` in the workspace. It returns actual function definitions, schema/ACL/policy metadata, format constraints and aggregate counts only—no post bodies or private user records.
2. Inspect the exact-anchor preflight: all **five installed function anchors** must match once. The new settings table, RPCs and category columns must be absent. CRLF is normalized symmetrically in catalog definitions and patch literals.
3. Apply `supabase/migrations/202610230002_news_category_archive.sql` as a complete transaction. Lock timeout is 5 seconds; statement timeout is 90 seconds. A mismatch rolls everything back. Do not continue individual fragments after failure.
4. Publish the matching category manager, active filter chips and archived-value-safe post editor.
5. Run the read-only postflight catalog inspection to confirm RLS/private table ACLs, narrow authenticated RPC grants, the five patched guards/contracts, unchanged category FK and unchanged publication-format constraint.

No new role, audience, persistent credential, email fanout, background job or paid service is introduced. No category/post content is copied or physically deleted. Rollback of an individual editor action is restoration through the same permission-checked manager.

No automated tests, build, production migration or push was performed by the database implementation subtask. Catalog inspection and static review are separate from exercising production user actions.
