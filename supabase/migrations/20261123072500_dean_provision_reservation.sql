begin;
set local lock_timeout='5s';
-- Auth Admin writes supplied app_metadata after INSERT. Reserve one exact UUID
-- and login through an administrator's live MFA session before that INSERT.
create table dean_private.provision_requests (
 user_id uuid primary key, login text not null unique,
 created_by uuid not null references public.profiles(id), session_id text not null,
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '2 minutes',
 consumed_at timestamptz
);
alter table dean_private.provision_requests enable row level security;
revoke all on dean_private.provision_requests from public,anon,authenticated,service_role;
create function public.xelay_dean_reserve_staff(p_user_id uuid,p_login text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if not dean_private.session_valid() then raise exception 'DEAN_MFA_REQUIRED' using errcode='42501'; end if;
 if not dean_private.is_admin() then raise exception 'DEAN_ADMIN_REQUIRED' using errcode='42501'; end if;
 if p_user_id is null or p_login is null or p_login !~ '^dean-[a-f0-9]{10}@dean[.]xelay[.]ink$'
   or exists(select 1 from auth.users where id=p_user_id or lower(email)=p_login)
 then raise exception 'DEAN_PROVISION_INVALID' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('dean-provision:'||auth.uid()::text,0));
 if (select count(*) from dean_private.provision_requests where created_by=auth.uid() and created_at>now()-interval '1 hour')>=25
 then raise exception 'DEAN_PROVISION_LIMIT' using errcode='42501'; end if;
 insert into dean_private.provision_requests(user_id,login,created_by,session_id)
 values(p_user_id,p_login,auth.uid(),auth.jwt()->>'session_id');
 return true;
end $$;
revoke all on function public.xelay_dean_reserve_staff(uuid,text) from public,anon,service_role;
grant execute on function public.xelay_dean_reserve_staff(uuid,text) to authenticated;
create function dean_private.bind_provisioned_identity() returns trigger
language plpgsql security definer set search_path='' as $$
declare r dean_private.provision_requests;
begin
 if not public.xelay_security_is_trusted_backend() then return new; end if;
 select * into r from dean_private.provision_requests where user_id=new.id and login=new.email
   and consumed_at is null and expires_at>now() for update;
 if not found then return new; end if;
 if not exists(select 1 from auth.sessions s join auth.users u on u.id=s.user_id
   join public.user_roles role on role.user_id=u.id and role.role='ADMIN'
   where s.id::text=r.session_id and s.user_id=r.created_by
     and (s.not_after is null or s.not_after>now()) and u.deleted_at is null
     and (u.banned_until is null or u.banned_until<=now())
     and exists(select 1 from auth.mfa_factors f where f.user_id=u.id and f.status='verified'))
 then raise exception 'DEAN_PROVISION_EXPIRED' using errcode='42501'; end if;
 new.raw_app_meta_data:=coalesce(new.raw_app_meta_data,'{}'::jsonb)||jsonb_build_object('dean_service',true,'created_by',r.created_by);
 update dean_private.provision_requests set consumed_at=now() where user_id=new.id;
 return new;
end $$;
revoke all on function dean_private.bind_provisioned_identity() from public,anon,authenticated,service_role;
create trigger xelay_01_dean_provision before insert on auth.users for each row execute function dean_private.bind_provisioned_identity();
commit;
