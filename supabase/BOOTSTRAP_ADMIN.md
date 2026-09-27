# Set up the first Xelay administrator

The first platform administrator must be assigned by the project owner in Supabase. This is a one-time bootstrap so no user can grant themselves administrator access from the app.

1. Create and confirm the account that will own the platform administration.
2. In Supabase, open **SQL Editor** and find that account's UUID:

   ```sql
   select id, email from auth.users where lower(email) = lower('your-admin-email@example.com');
   ```

3. Copy the UUID returned by that query and grant the platform role:

   ```sql
   insert into public.user_roles (user_id, role)
   values ('PASTE-USER-UUID-HERE', 'ADMIN')
   on conflict do nothing;
   ```

4. Sign out and back in to Xelay. The **Адмінпанель** route will then be available at `/admin`.

Use this platform role sparingly. Faculty news editors should apply through **Новини**; an administrator can approve or reject each request. Approved editors can publish only in the faculty or institute attached to their request.

Existing Xelay accounts are not assigned a university automatically. Each account should select its university and faculty or institute in profile settings before its faculty-specific news feed is available.
