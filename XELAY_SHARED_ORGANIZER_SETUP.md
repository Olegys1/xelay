# Shared organizer setup

Apply `supabase/migrations/202610090001_shared_organizer.sql` after the existing profile username and participant billing migrations. The SQL runs in one transaction and creates separate shared organizer tables and authenticated RPCs. It does not modify personal organizer tasks, study groups, billing, notifications, or storage.

The migration was applied to production Supabase `Xelay mvp` (`baohfpadxvhqhhjjqtil`) on 9 October 2026. The SQL editor reported `Success. No rows returned` after the transaction completed. Production build and TypeScript compilation completed successfully. Automated tests and live task or invitation scenarios were not run.

## Access and membership

- Every application RPC requires authentication and `xelay_has_participant_access(auth.uid())`.
- Workspaces are private. Only accepted members with active participant access can read their contents. A pending invitation exposes its own invitation metadata to its invited active user and never exposes tasks or members.
- The owner occupies one of five seats. Accepted memberships and pending invitations that have not expired together occupy at most five seats. `member_count` counts accepted memberships only, including the owner.
- Only the owner can invite by an exact username, rename, archive, cancel invitations, or remove other members. Optional `@` and letter case are normalized; email addresses and partial username search are not accepted.
- Invitees must have active participant access both when invited and when accepting. Invitations expire seven days after creation and require explicit acceptance or decline.
- A non-owner can leave their own workspace. Owners archive their workspace instead of leaving. Ownership cannot be transferred.
- Subscription expiry blocks the expired user from every shared organizer RPC. Their membership and seat remain, and other active members retain access even when the owner has expired.
- All active accepted members may create, edit, complete, and delete tasks. A new or changed assignee must be an accepted member with active participant access. An existing assignment can stay unchanged after that member's subscription expires.
- Removing a member, leaving, or cancelling an invitation clears matching task assignments and advances their task versions. Tasks and historical creator/updater identifiers remain.
- Archiving retains workspace data, cancels pending invitations, and removes all application visibility. Deleting an owner account cascades its owned workspace data; deleting another member's account removes their membership and clears their assignments without deleting the remaining members' tasks.

## Security and concurrency

All five new tables have RLS enabled and no application table policies. Direct table access and helper-function execution are revoked from `public`, `anon`, `authenticated`, and `service_role`. The public entry points are granted only to `authenticated`, validate the actor themselves, and use a fixed search path.

Every membership, invitation, and task operation locks the workspace row before checking or changing its state. Overview locks matching workspace rows in UUID order and returns only metadata from the locked rows. This serializes acceptance, cancellation, removal, archiving, and task assignment with the five-seat check. Additional private locks serialize creation limits for one owner and pending inbox limits for one invitee across workspaces.

Task IDs, workspace identity, creator, creation timestamp, and owner are immutable. The server supplies the updater and strictly increasing timestamps. Rename, archive, task edit, and task delete require the exact observed `updated_at`; a mismatch raises `SHARED_ORGANIZER_CONFLICT`. Keep the timestamp string from the RPC intact when sending it back; converting it through a JavaScript `Date` can lose the server's fractional-second precision.

Task notes are plain text. Profile responses contain only bounded display names, usernames, and avatar URLs; they contain no email addresses. Shared invitations use the shared organizer inbox and create no notification or email records.

## Limits

| Limit | Value |
| --- | --- |
| Seats, including owner and unexpired pending reservations | 5 per workspace |
| Active workspaces owned by one user | 10 |
| Successful workspace creations by one user | 10 per Kyiv calendar day |
| Successful invitations sent by one user | 50 per Kyiv calendar day |
| Unexpired pending incoming invitations | 20 per user |
| Stored tasks, including completed tasks | 1,000 per workspace |
| Tasks in one workspace response | 1–100; default 100 |
| Workspace name | 1–100 trimmed characters |
| Task title | 1–200 trimmed characters |
| Task notes | Up to 10,000 characters |
| Task subject | Up to 120 trimmed characters |

Daily counters survive cancellation and archiving. Failed transactions do not consume a counter. Date-only and timed deadlines are mutually exclusive; both may be absent. Deadlines must be finite and within years 0001–9999; JSON timestamps are serialized in UTC. Sorting uses incomplete tasks first, then the deadline (date-only deadlines at the end of their Kyiv calendar day), then creation time and ID.

## RPC contract

| RPC | Inputs | Response |
| --- | --- | --- |
| `xelay_shared_organizer_overview` | None | `{workspaces: [], invitations: []}` |
| `xelay_shared_organizer_workspace` | `p_workspace_id`, `p_offset = 0`, `p_limit = 100` | `{workspace, members: [], invitations: [], tasks: [], total}`; outgoing pending invitations are owner-only |
| `xelay_create_shared_organizer` | `p_name` | Workspace UUID |
| `xelay_rename_shared_organizer` | `p_workspace_id`, `p_name`, `p_expected_updated_at` | Void |
| `xelay_invite_shared_organizer` | `p_workspace_id`, `p_username` | Invitation UUID |
| `xelay_respond_shared_organizer_invite` | `p_invitation_id`, `p_accept` | Workspace UUID on accept; null on decline |
| `xelay_cancel_shared_organizer_invite` | `p_invitation_id` | Void |
| `xelay_remove_shared_organizer_member` | `p_workspace_id`, `p_user_id` | Void; owner removes another member or non-owner leaves self |
| `xelay_save_shared_organizer_task` | `p_workspace_id`, `p_task_id`, `p_expected_updated_at`, `p_title`, `p_notes`, `p_subject`, `p_due_date`, `p_due_at`, `p_assignee_id`, `p_completed` | Saved task object; null task ID and null expected version create a task |
| `xelay_delete_shared_organizer_task` | `p_workspace_id`, `p_task_id`, `p_expected_updated_at` | Void |
| `xelay_archive_shared_organizer` | `p_workspace_id`, `p_expected_updated_at` | Void |

Workspace objects contain `id`, `name`, `owner_id`, `created_at`, `updated_at`, and `member_count`. Member objects contain `workspace_id`, `user_id`, `role` (`owner` or `member`), `full_name`, nullable `username`, nullable `avatar_url`, and `is_premium`. Invitation objects contain `id`, `workspace_id`, `workspace_name`, `inviter_name`, `invitee_id`, `invitee_name`, `invitee_username`, `expires_at`, and `created_at`.

Task objects contain `id`, `workspace_id`, `created_by`, `updated_by`, nullable `assignee_id`, `title`, `notes`, `subject`, nullable `due_at`, nullable `due_date`, `completed`, `created_at`, and `updated_at`. JSON responses are PostgreSQL `jsonb` and are returned as ordinary objects by the Supabase client.

## Error codes

All feature errors start with `SHARED_ORGANIZER_`. The suffixes are:

`AUTH_REQUIRED`, `PARTICIPANT_REQUIRED`, `WORKSPACE_UNAVAILABLE`, `NOT_MEMBER`, `OWNER_REQUIRED`, `OWNER_CANNOT_LEAVE`, `IDENTITY_IMMUTABLE`, `INVALID_NAME`, `OWNED_WORKSPACE_LIMIT`, `CREATE_RATE_LIMIT`, `INVALID_USERNAME`, `USER_NOT_FOUND`, `SELF_INVITE`, `INVITEE_PARTICIPANT_REQUIRED`, `ALREADY_MEMBER`, `INVITATION_PENDING`, `WORKSPACE_FULL`, `INVITE_RATE_LIMIT`, `INVITEE_INVITATION_LIMIT`, `INVALID_INVITATION`, `INVITATION_UNAVAILABLE`, `INVITATION_EXPIRED`, `MEMBER_UNAVAILABLE`, `INVALID_PAGE`, `INVALID_TASK`, `INVALID_DEADLINE`, `ASSIGNEE_UNAVAILABLE`, `TASK_UNAVAILABLE`, `TASK_LIMIT`, and `CONFLICT`.

Permission errors use SQLSTATE `42501`, validation errors use `22023`, quotas use `54000`, and optimistic version conflicts use `40001`.
