-- Shared study-group roster. Accepted participants see accepted members;
-- invitation management remains available to the representative and admins.
begin;

do $$
begin
  if to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or to_regprocedure('public.xelay_is_study_group_representative(uuid)') is null
  then
    raise exception 'Apply the study-group migrations before the roster migration';
  end if;
end;
$$;

-- Query membership with the function owner's privileges to avoid recursive
-- study_group_members RLS. No invitation, acceptance or removal rights change.
create or replace function public.xelay_can_read_study_group_membership(
  p_group_id uuid,
  p_user_id uuid,
  p_status text
)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and coalesce(
    p_user_id = auth.uid()
    or public.xelay_is_platform_admin()
    or public.xelay_is_study_group_representative(p_group_id)
    or (
      p_status = 'accepted'
      and exists (
        select 1 from public.study_group_members viewer
        where viewer.group_id = p_group_id
          and viewer.user_id = auth.uid()
          and viewer.status = 'accepted'
      )
    ),
    false
  );
$$;

revoke all on function public.xelay_can_read_study_group_membership(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.xelay_can_read_study_group_membership(uuid, uuid, text)
  to authenticated;

alter table public.study_group_members enable row level security;

drop policy if exists "Users and representatives can view group membership"
  on public.study_group_members;
create policy "Users and representatives can view group membership"
  on public.study_group_members for select to authenticated
  using (public.xelay_can_read_study_group_membership(group_id, user_id, status));

-- Permissive policies combine with OR. This guard also constrains any older
-- permissive SELECT/ALL policy that may exist in an already deployed project.
drop policy if exists "Study group roster visibility guard"
  on public.study_group_members;
create policy "Study group roster visibility guard"
  on public.study_group_members as restrictive for select to authenticated
  using (public.xelay_can_read_study_group_membership(group_id, user_id, status));

-- Send roster/group updates when Realtime is configured. Keep the default
-- replica identity so deleted rows do not broadcast the old membership body.
do $$
declare
  v_table text;
begin
  if exists (
    select 1 from pg_publication
    where pubname = 'supabase_realtime' and not puballtables
  ) then
    foreach v_table in array array['study_groups', 'study_group_members'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public' and tablename = v_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end;
$$;

commit;
