-- Persisted round robin prevents a slow private backlog starving public cleanup.
begin;
create table public.security_media_maintenance_cursor (
  singleton boolean primary key default true check(singleton),
  next_scope text not null default 'private' check(next_scope in ('private','public'))
);
insert into public.security_media_maintenance_cursor(singleton) values(true);
alter table public.security_media_maintenance_cursor enable row level security;
revoke all on public.security_media_maintenance_cursor from public,anon,authenticated;
create function public.xelay_media_cleanup_next_scope()
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v_scope text;
begin
  select next_scope into v_scope from public.security_media_maintenance_cursor where singleton for update;
  update public.security_media_maintenance_cursor set next_scope=case v_scope when 'private' then 'public' else 'private' end where singleton;
  return v_scope;
end $$;
revoke all on function public.xelay_media_cleanup_next_scope() from public,anon,authenticated;
grant execute on function public.xelay_media_cleanup_next_scope() to service_role;
commit;
