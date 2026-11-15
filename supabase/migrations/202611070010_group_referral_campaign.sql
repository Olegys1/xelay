-- Group referral campaign. Installation seeds a draft, never an active campaign.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$begin
 if to_regclass('public.study_groups') is null or to_regclass('public.study_group_materials') is null
  or to_regprocedure('public.xelay_is_platform_admin()') is null
  or to_regprocedure('public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)') is null then
  raise exception 'REFERRAL_PREREQUISITES_MISSING';end if;
end$$;

create table public.group_referral_campaigns(
 id uuid primary key default gen_random_uuid(),slug text not null unique check(slug~'^[a-z0-9-]{3,60}$'),
 title text not null default 'Приведи свою групу в Xelay' check(char_length(title) between 3 and 160),
 state text not null default 'draft' check(state in('draft','open','frozen','drawn','published','cancelled')),
 version integer not null default 1 check(version>0),starts_at timestamptz,joins_until timestamptz,qualifies_until timestamptz,draw_at timestamptz,
 minimum_students integer not null default 10 check(minimum_students=10),rules_version text not null default 'group-referral-v1',
 prizes jsonb not null default '[{"rank":1,"label":"ChatGPT Plus","months":1},{"rank":2,"label":"Telegram Premium","months":6},{"rank":3,"label":"Telegram Premium","months":3}]',
 created_at timestamptz not null default clock_timestamp(),frozen_at timestamptz,snapshot_hash text,drawn_at timestamptz,published_at timestamptz
);
create table public.group_referral_links(
 id uuid primary key default gen_random_uuid(),campaign_id uuid not null references public.group_referral_campaigns,
 owner_id uuid not null references public.profiles(id),code text not null unique default upper(replace(gen_random_uuid()::text,'-','')),
 alias text not null check(char_length(alias) between 3 and 60 and alias !~ '[[:cntrl:]<>@]' and alias !~ '[0-9]{7}'),
 rules_version text not null,consented_at timestamptz not null default clock_timestamp(),unique(campaign_id,owner_id)
);
create table public.group_referral_entries(
 id uuid primary key default gen_random_uuid(),campaign_id uuid not null references public.group_referral_campaigns,
 group_id uuid not null references public.study_groups(id),link_id uuid not null references public.group_referral_links,
 organizer_id uuid not null references public.profiles(id),representative_id uuid not null references public.profiles(id),
 group_created_at timestamptz not null,registered_at timestamptz not null default clock_timestamp(),
 identity_key text not null,state text not null default 'collecting' check(state in('collecting','pending','approved','rejected')),
 version integer not null default 1,review_reason text,reviewed_at timestamptz,reviewed_by uuid,
 unique(campaign_id,group_id),unique(campaign_id,identity_key)
);
create index group_referral_entries_organizer on public.group_referral_entries(campaign_id,organizer_id,id);
create table public.group_referral_credits(
 campaign_id uuid not null references public.group_referral_campaigns,user_id uuid not null references public.profiles(id),
 entry_id uuid not null references public.group_referral_entries,first_seen_at timestamptz not null default clock_timestamp(),
 primary key(campaign_id,user_id),unique(entry_id,user_id)
);
create table public.group_referral_reads(
 id uuid primary key default gen_random_uuid(),campaign_id uuid not null,user_id uuid not null,entry_id uuid not null,
 day date not null,observed_at timestamptz not null default clock_timestamp(),kind text not null check(kind in('schedule','homework','material')),
 resource_id uuid not null,foreign key(entry_id,user_id) references public.group_referral_credits(entry_id,user_id),
 unique(entry_id,user_id,day,kind,resource_id)
);
create index group_referral_reads_entry on public.group_referral_reads(entry_id,user_id,day);
create table public.group_referral_snapshots(
 campaign_id uuid not null references public.group_referral_campaigns,entry_id uuid not null references public.group_referral_entries,
 organizer_id uuid not null,alias text not null,proof jsonb not null,frozen_at timestamptz not null default clock_timestamp(),
 primary key(campaign_id,entry_id)
);
create table public.group_referral_draw_orders(
 campaign_id uuid not null references public.group_referral_campaigns,entry_id uuid not null,
 random_key uuid not null default gen_random_uuid(),primary key(campaign_id,entry_id),
 foreign key(campaign_id,entry_id) references public.group_referral_snapshots
);
create table public.group_referral_winners(
 id uuid primary key default gen_random_uuid(),campaign_id uuid not null references public.group_referral_campaigns,
 organizer_id uuid not null,rank integer not null check(rank between 1 and 3),alias text not null,prize jsonb not null,
 prize_status text not null default 'pending' check(prize_status in('pending','issued')),
 interview_status text not null default 'pending' check(interview_status in('pending','invited','declined','completed')),
 version integer not null default 1,unique(campaign_id,rank),unique(campaign_id,organizer_id)
);
create table public.group_referral_commands(
 campaign_id uuid not null references public.group_referral_campaigns,request_id uuid not null,actor_id uuid not null,
 action text not null,payload_hash text not null,created_at timestamptz not null default clock_timestamp(),primary key(campaign_id,request_id)
);
create table public.group_referral_audit(
 id uuid primary key default gen_random_uuid(),campaign_id uuid not null references public.group_referral_campaigns,
 actor_id uuid not null,action text not null,target uuid,reason text,created_at timestamptz not null default clock_timestamp()
);
do $$declare n text;begin
 foreach n in array array['campaigns','links','entries','credits','reads','snapshots','draw_orders','winners','commands','audit'] loop
  execute format('alter table public.group_referral_%I enable row level security',n);
  execute format('revoke all on public.group_referral_%I from public,anon,authenticated,service_role',n);
 end loop;
end$$;

create function public.xelay_private_referral_account(p_user uuid,p_student boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users u join public.profiles p on p.id=u.id where u.id=p_user
  and u.email_confirmed_at is not null and u.deleted_at is null and coalesce(u.banned_until,'-infinity')<=statement_timestamp()
  and (not p_student or coalesce(to_jsonb(p)->>'account_type','student')='student'));
$$;
create function public.xelay_private_referral_admin() returns boolean language sql stable security definer set search_path='' as $$
 select public.xelay_private_referral_account(auth.uid()) and coalesce(public.xelay_is_platform_admin(),false)
  and auth.jwt()->>'aal'='aal2' and exists(select 1 from public.user_roles r where r.user_id=auth.uid() and r.role='ADMIN')
  and exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified');
$$;
create function public.xelay_private_referral_member(p_group uuid,p_user uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.xelay_private_referral_account(p_user,true) and exists(select 1 from public.study_groups g where g.id=p_group
  and(g.representative_id=p_user or exists(select 1 from public.study_group_members m where m.group_id=g.id and m.user_id=p_user and m.status='accepted')));
$$;
create function public.xelay_private_referral_identity(p_group uuid) returns text language sql stable security definer set search_path='' as $$
 select encode(extensions.digest(concat_ws('|',g.university_id::text,g.academic_unit_id::text,
  regexp_replace(lower(btrim(g.specialty)),'[[:space:]]+',' ','g'),
  regexp_replace(lower(btrim(g.group_name)),'[[:space:]-]+','','g'),
  coalesce(to_jsonb(g)->>'cohort_start_year','unknown'),coalesce(to_jsonb(g)->>'study_level','unknown')),'sha256'),'hex')
 from public.study_groups g where g.id=p_group;
$$;
create function public.xelay_private_referral_real_group(p_group uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.study_groups g join public.class_representative_requests r on r.id=g.representative_request_id
  where g.id=p_group and r.status='approved'
  and g.id not in('437c96ae-19d1-4bed-ae69-0b83ae9ec1b4'::uuid,'445fcadc-95e2-4f8c-bfb3-6d0998030a01'::uuid)
  and lower(g.group_name)!~'(^|[^[:alpha:]])(test|тест|ооо|ooo)([^[:alpha:]]|$)'
  and not exists(select 1 from public.study_groups d where d.id<>g.id and d.university_id=g.university_id and d.academic_unit_id=g.academic_unit_id
   and regexp_replace(lower(btrim(d.group_name)),'[[:space:]-]+','','g')=regexp_replace(lower(btrim(g.group_name)),'[[:space:]-]+','','g')
   and regexp_replace(lower(btrim(d.specialty)),'[[:space:]]+',' ','g')=regexp_replace(lower(btrim(g.specialty)),'[[:space:]]+',' ','g')
   and coalesce(to_jsonb(d)->>'cohort_start_year','unknown')=coalesce(to_jsonb(g)->>'cohort_start_year','unknown')
   and coalesce(to_jsonb(d)->>'study_level','unknown')=coalesce(to_jsonb(g)->>'study_level','unknown')));
$$;
create function public.xelay_private_referral_resource(p_group uuid,p_kind text,p_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select case p_kind
 when 'schedule' then exists(select 1 from public.study_group_schedule s where s.id=p_id and s.group_id=p_group and length(btrim(s.subject))>0 and s.ends_at>s.starts_at)
 when 'homework' then exists(select 1 from public.study_group_homework h join public.study_group_schedule s on s.id=h.schedule_item_id and s.group_id=h.group_id where h.id=p_id and h.group_id=p_group and length(btrim(h.body))>0)
 when 'material' then exists(select 1 from public.study_group_materials m where m.id=p_id and m.group_id=p_group and(length(btrim(m.body))>0 or jsonb_array_length(m.links)>0 or jsonb_array_length(m.attachments)>0))
 else false end;
$$;
create function public.xelay_private_referral_campaign_json(c public.group_referral_campaigns) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',c.id,'slug',c.slug,'title',c.title,'state',c.state,'version',c.version,
 'startsAt',c.starts_at,'joinsUntil',c.joins_until,'qualifiesUntil',c.qualifies_until,'drawAt',c.draw_at,'minimumStudents',c.minimum_students,
 'prizes',c.prizes,'rulesVersion',c.rules_version,'frozenAt',c.frozen_at,'snapshotHash',c.snapshot_hash,'drawnAt',c.drawn_at,'publishedAt',c.published_at);
$$;
create function public.xelay_private_referral_progress(p_entry uuid,p_viewer uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e public.group_referral_entries%rowtype;c public.group_referral_campaigns%rowtype;g public.study_groups%rowtype;
 v_verified integer;v_returned integer;v_own_days integer;v_schedule boolean;v_resource boolean;v_rep boolean;v_issues text[]:='{}';v_week date;v_alias text;
begin
 select * into e from public.group_referral_entries where id=p_entry;
 select * into c from public.group_referral_campaigns where id=e.campaign_id;
 select * into g from public.study_groups where id=e.group_id;
 select alias into v_alias from public.group_referral_links where id=e.link_id;
 select count(*) into v_verified from (select g.representative_id u union select m.user_id from public.study_group_members m where m.group_id=g.id and m.status='accepted') users
  where public.xelay_private_referral_member(g.id,u);
 with days as (
  select r.user_id,count(distinct r.day) n from public.group_referral_reads r join public.group_referral_credits cr on cr.entry_id=r.entry_id and cr.user_id=r.user_id
  where r.entry_id=e.id and cr.campaign_id=e.campaign_id and public.xelay_private_referral_member(g.id,r.user_id)
   and r.observed_at>=cr.first_seen_at and r.observed_at<=cr.first_seen_at+interval '168 hours' and r.observed_at>=e.registered_at
   and r.observed_at<=c.qualifies_until and r.day=(r.observed_at at time zone 'Europe/Kyiv')::date
   and public.xelay_private_referral_resource(g.id,r.kind,r.resource_id)
   and(g.representative_id=r.user_id or exists(select 1 from public.study_group_members m where m.group_id=g.id and m.user_id=r.user_id and m.status='accepted' and coalesce(m.accepted_at,m.created_at)<=r.observed_at))
  group by r.user_id
 ) select count(*) filter(where n>=2),coalesce(bool_or(user_id=g.representative_id and n>=2),false),coalesce(max(n) filter(where user_id=p_viewer),0)
 into v_returned,v_rep,v_own_days from days;
 v_week:=date_trunc('week',statement_timestamp() at time zone 'Europe/Kyiv')::date;
 select exists(select 1 from public.study_group_schedule s cross join generate_series(0,13) d
  where s.group_id=g.id and length(btrim(s.subject))>0 and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,v_week+d)
   and not(v_week+d=any(coalesce((select array_agg(value::date) from jsonb_array_elements_text(coalesce(nullif(to_jsonb(s)->'excluded_dates','null'::jsonb),'[]'::jsonb)) a(value)),'{}'::date[])))) into v_schedule;
 select exists(select 1 from public.study_group_homework h where h.group_id=g.id and public.xelay_private_referral_resource(g.id,'homework',h.id))
  or exists(select 1 from public.study_group_materials m where m.group_id=g.id and public.xelay_private_referral_resource(g.id,'material',m.id)) into v_resource;
 if not public.xelay_private_referral_real_group(g.id) then v_issues:=array_append(v_issues,'group_not_real_or_duplicate');end if;
 if g.representative_id is distinct from e.representative_id then v_issues:=array_append(v_issues,'representative_changed');end if;
 if public.xelay_private_referral_identity(g.id) is distinct from e.identity_key then v_issues:=array_append(v_issues,'group_identity_changed');end if;
 if not public.xelay_private_referral_account(e.organizer_id) then v_issues:=array_append(v_issues,'organizer_unavailable');end if;
 if g.created_at<c.starts_at or g.created_at is distinct from e.group_created_at then v_issues:=array_append(v_issues,'old_or_changed_group');end if;
 if v_verified<10 then v_issues:=array_append(v_issues,'need_ten_verified_students');end if;
 if v_returned<10 then v_issues:=array_append(v_issues,'need_ten_returning_students');end if;
 if not v_rep then v_issues:=array_append(v_issues,'representative_must_return');end if;
 if not v_schedule then v_issues:=array_append(v_issues,'need_current_schedule');end if;
 if not v_resource then v_issues:=array_append(v_issues,'need_homework_or_material');end if;
 return jsonb_build_object('id',e.id,'groupId',e.group_id,'groupName',g.group_name,'organizerId',e.organizer_id,'organizerAlias',v_alias,
  'createdAt',e.group_created_at,'registeredAt',e.registered_at,'state',e.state,'version',e.version,'verifiedStudents',v_verified,
  'returningStudents',v_returned,'hasSchedule',v_schedule,'hasResource',v_resource,'eligible',cardinality(v_issues)=0,'issues',to_jsonb(v_issues),
  'reviewReason',e.review_reason,'reviewedAt',e.reviewed_at,'ownMemberDays',least(v_own_days,2),
  'ownMemberCounts',exists(select 1 from public.group_referral_credits cr where cr.campaign_id=c.id and cr.user_id=p_viewer and cr.entry_id=e.id) and public.xelay_private_referral_member(g.id,p_viewer),
  'viewerRole',case when p_viewer=e.organizer_id then 'organizer' when p_viewer=e.representative_id then 'representative' else 'member' end,
  'canSubmit',p_viewer in(e.organizer_id,e.representative_id) and e.state in('collecting','rejected') and c.state='open' and statement_timestamp()<=c.qualifies_until);
end$$;

create function public.xelay_group_referral_workspace(p_slug text default 'bring-your-group',p_after uuid default null,p_admin_after uuid default null,p_candidate_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.group_referral_campaigns%rowtype;v_user uuid:=auth.uid();v_admin boolean:=false;v_own jsonb:='[]';v_admin_groups jsonb:='[]';v_candidates jsonb:='[]';v_link jsonb;v_winners jsonb:='[]';v_next uuid;v_admin_next uuid;v_candidate_next uuid;v_tickets integer:=0;v_approved integer:=0;v_organizers integer:=0;v_audit jsonb:='[]';
begin
 select * into c from public.group_referral_campaigns where slug=p_slug;
 if not found then return jsonb_build_object('campaign',null,'actor',null,'ownLink',null,'ownGroups','[]'::jsonb,'candidateGroups','[]'::jsonb,'ownTickets',0,'winners','[]'::jsonb);end if;
 if v_user is not null and auth.role()='authenticated' then v_admin:=public.xelay_private_referral_admin();else v_user:=null;end if;
 if v_user is not null then
  select jsonb_build_object('code',code,'path','/referrals?code='||code) into v_link from public.group_referral_links where campaign_id=c.id and owner_id=v_user;
  with page as(select e.id from public.group_referral_entries e where e.campaign_id=c.id and(p_after is null or e.id>p_after)
   and(e.organizer_id=v_user or e.representative_id=v_user or public.xelay_private_referral_member(e.group_id,v_user)) order by e.id limit 51),numbered as(select id,row_number()over(order by id) n from page)
  select coalesce(jsonb_agg(public.xelay_private_referral_progress(id,v_user) order by id) filter(where n<=50),'[]'::jsonb),
   case when count(*)>50 then(array_agg(id order by id))[50] else null end into v_own,v_next from numbered;
  select count(*) into v_tickets from public.group_referral_entries e where e.campaign_id=c.id and e.organizer_id=v_user and e.state='approved'
   and(case when c.state in('frozen','drawn','published') then exists(select 1 from public.group_referral_snapshots s where s.campaign_id=c.id and s.entry_id=e.id) else(public.xelay_private_referral_progress(e.id,v_user)->>'eligible')::boolean end);
  with page as(select g.* from public.study_groups g where g.representative_id=v_user and(p_candidate_after is null or g.id>p_candidate_after)
   and not exists(select 1 from public.group_referral_entries ent where ent.campaign_id=c.id and ent.group_id=g.id) order by g.id limit 51),numbered as(select page.*,row_number()over(order by id)n from page)
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.group_name,'createdAt',g.created_at,
   'canRegister',c.state='open' and statement_timestamp() between c.starts_at and c.joins_until and g.created_at>=c.starts_at and statement_timestamp()<=g.created_at+interval '24 hours' and public.xelay_private_referral_real_group(g.id),
   'reason',case when g.created_at<c.starts_at then 'REFERRAL_OLD_GROUP' when not public.xelay_private_referral_real_group(g.id) then 'REFERRAL_GROUP_INELIGIBLE' when statement_timestamp()>g.created_at+interval '24 hours' then 'REFERRAL_REGISTRATION_EXPIRED' else null end) order by g.id) filter(where g.n<=50),'[]'::jsonb),
   case when count(*)>50 then(array_agg(g.id order by g.id))[50] else null end into v_candidates,v_candidate_next from numbered g;
 end if;
 if c.state='published' or v_admin then
  select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'rank',w.rank,'alias',w.alias,'prize',w.prize,'version',w.version,'isOwn',coalesce(w.organizer_id=v_user,false))
    ||case when v_admin or w.organizer_id=v_user then jsonb_build_object('organizerId',w.organizer_id,'prizeStatus',w.prize_status,'interviewStatus',w.interview_status) else '{}'::jsonb end order by w.rank),'[]'::jsonb)
   into v_winners from public.group_referral_winners w where w.campaign_id=c.id;
 end if;
 if v_admin then
  with page as(select id from public.group_referral_entries where campaign_id=c.id and(p_admin_after is null or id>p_admin_after) order by id limit 51),numbered as(select id,row_number()over(order by id)n from page)
  select coalesce(jsonb_agg(public.xelay_private_referral_progress(id,v_user) order by id) filter(where n<=50),'[]'::jsonb),case when count(*)>50 then(array_agg(id order by id))[50] else null end into v_admin_groups,v_admin_next from numbered;
  select count(*),count(distinct organizer_id) into v_approved,v_organizers from public.group_referral_entries e where e.campaign_id=c.id and e.state='approved' and(public.xelay_private_referral_progress(e.id,v_user)->>'eligible')::boolean;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'at',a.created_at,'action',a.action,'actorAlias',coalesce(l.alias,'Адміністрація'),'reason',a.reason,'target',a.target) order by a.created_at desc,a.id),'[]'::jsonb) into v_audit
   from(select * from public.group_referral_audit where campaign_id=c.id order by created_at desc,id limit 50)a left join public.group_referral_links l on l.campaign_id=a.campaign_id and l.owner_id=a.actor_id;
 end if;
 return jsonb_build_object('campaign',public.xelay_private_referral_campaign_json(c),'actor',case when v_user is null then null else jsonb_build_object('id',v_user,'verified',public.xelay_private_referral_account(v_user),'alias',coalesce((select alias from public.group_referral_links where campaign_id=c.id and owner_id=v_user),''),'canAdmin',v_admin)end,
 'ownLink',v_link,'ownGroups',v_own,'candidateGroups',v_candidates,'candidateNextCursor',v_candidate_next,'ownTickets',v_tickets,'nextCursor',v_next,'winners',v_winners)
 ||case when v_admin then jsonb_build_object('admin',jsonb_build_object('groups',v_admin_groups,'audit',v_audit,'approvedTickets',v_approved,'eligibleOrganizers',v_organizers,'nextCursor',v_admin_next)) else '{}'::jsonb end;
end$$;

create function public.xelay_group_referral_observe_read(p_group_id uuid,p_kind text,p_resource_id uuid,p_expected_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();e public.group_referral_entries%rowtype;c public.group_referral_campaigns%rowtype;cr public.group_referral_credits%rowtype;v_now timestamptz:=clock_timestamp();
begin
 if auth.role() is distinct from 'authenticated' or v_user is null or v_user is distinct from p_expected_user_id then raise exception 'REFERRAL_AUTH_REQUIRED' using errcode='42501';end if;
 if not public.xelay_private_referral_account(v_user,true) then raise exception 'REFERRAL_VERIFICATION_REQUIRED' using errcode='42501';end if;
 if not public.xelay_private_referral_member(p_group_id,v_user) or not public.xelay_private_referral_resource(p_group_id,p_kind,p_resource_id) then raise exception 'REFERRAL_GROUP_FORBIDDEN' using errcode='42501';end if;
 select ce.* into e from public.group_referral_entries ce join public.group_referral_campaigns cc on cc.id=ce.campaign_id where ce.group_id=p_group_id and cc.state='open' and v_now between cc.starts_at and cc.qualifies_until order by cc.created_at desc limit 1;
 if not found then return jsonb_build_object('counted',false,'reason','no_open_entry');end if;
 select * into c from public.group_referral_campaigns where id=e.campaign_id for share;
 if c.state<>'open' or v_now>c.qualifies_until then return jsonb_build_object('counted',false,'reason','closed');end if;
 insert into public.group_referral_credits(campaign_id,user_id,entry_id,first_seen_at) values(c.id,v_user,e.id,v_now) on conflict do nothing;
 select * into cr from public.group_referral_credits where campaign_id=c.id and user_id=v_user for update;
 if cr.entry_id<>e.id or v_now>cr.first_seen_at+interval '168 hours' then return jsonb_build_object('counted',false,'reason','credited_elsewhere_or_window_closed');end if;
 insert into public.group_referral_reads(campaign_id,user_id,entry_id,day,observed_at,kind,resource_id)
 values(c.id,v_user,e.id,(v_now at time zone 'Europe/Kyiv')::date,v_now,p_kind,p_resource_id) on conflict do nothing;
 return jsonb_build_object('counted',true,'day',(v_now at time zone 'Europe/Kyiv')::date);
end$$;

create function public.xelay_group_referral_action(p_action text,p_payload jsonb,p_expected_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();c public.group_referral_campaigns%rowtype;e public.group_referral_entries%rowtype;g public.study_groups%rowtype;l public.group_referral_links%rowtype;w public.group_referral_winners%rowtype;
 v_request uuid;v_hash text;v_command public.group_referral_commands%rowtype;v_now timestamptz:=clock_timestamp();v_reason text;v_alias text;v_proof jsonb;v_snapshot jsonb;v_rank integer;v_count integer;v_version integer;v_allowed text[];v_admin boolean;v_id uuid;
begin
 if auth.role() is distinct from 'authenticated' or v_user is null or v_user is distinct from p_expected_user_id then raise exception 'REFERRAL_AUTH_REQUIRED' using errcode='42501';end if;
 if not public.xelay_private_referral_account(v_user) then raise exception 'REFERRAL_VERIFICATION_REQUIRED' using errcode='42501';end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>10000 then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
 begin v_request:=(p_payload->>'requestId')::uuid;v_id:=(p_payload->>'campaignId')::uuid;v_version:=(p_payload->>'version')::integer;exception when others then raise exception 'REFERRAL_INVALID_PAYLOAD';end;
 if v_request is null or v_id is null then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
 select * into c from public.group_referral_campaigns where id=v_id for update;
 if not found then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
 v_hash:=encode(extensions.digest(p_payload::text,'sha256'),'hex');
 select * into v_command from public.group_referral_commands where campaign_id=c.id and request_id=v_request;
 if found then
  if v_command.actor_id<>v_user or v_command.action<>p_action or v_command.payload_hash<>v_hash then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
  return public.xelay_group_referral_workspace(c.slug);
 end if;
 v_admin:=public.xelay_private_referral_admin();
 v_allowed:=array['campaignId','requestId'];
 case p_action
 when 'create_link' then v_allowed:=v_allowed||array['alias','acceptRules'];
 when 'register_group' then v_allowed:=v_allowed||array['groupId','code'];
 when 'submit_group' then v_allowed:=v_allowed||array['entryId','version'];
 when 'review_group' then v_allowed:=v_allowed||array['entryId','version','decision','reason'];
 when 'save_campaign' then v_allowed:=v_allowed||array['version','title','startsAt','joinsUntil','qualifiesUntil','drawAt','prizes'];
 when 'activate_campaign','freeze_entries','draw_winners','publish_results' then v_allowed:=v_allowed||array['version','confirm'];
 when 'set_prize_status' then v_allowed:=v_allowed||array['winnerId','version','prizeStatus','reason'];
 when 'set_interview_status' then v_allowed:=v_allowed||array['winnerId','version','interviewStatus','reason'];
 else raise exception 'REFERRAL_INVALID_PAYLOAD';end case;
 if p_payload-v_allowed<>'{}'::jsonb then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
 if p_action not in('create_link','register_group','submit_group') then
  if p_action='set_interview_status' and not v_admin then
   if c.state<>'published' or p_payload->>'interviewStatus'<>'declined' or not exists(select 1 from public.group_referral_winners where id=(p_payload->>'winnerId')::uuid and campaign_id=c.id and organizer_id=v_user) then raise exception 'REFERRAL_ADMIN_REQUIRED' using errcode='42501';end if;
  elsif not v_admin then
   if exists(select 1 from public.user_roles where user_id=v_user and role='ADMIN') then raise exception 'REFERRAL_MFA_REQUIRED' using errcode='42501';end if;
   raise exception 'REFERRAL_ADMIN_REQUIRED' using errcode='42501';
  end if;
 end if;
 if p_action in('save_campaign','activate_campaign','freeze_entries','draw_winners','publish_results') and v_version is distinct from c.version then raise exception 'REFERRAL_VERSION_CONFLICT' using errcode='PT409';end if;
 v_reason:=nullif(btrim(p_payload->>'reason'),'');
 if char_length(v_reason)>1000 or v_reason~'[[:cntrl:]]' then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
 case p_action
 when 'create_link' then
  if c.state<>'open' or v_now not between c.starts_at and c.joins_until then raise exception 'REFERRAL_NOT_OPEN';end if;
  v_alias:=btrim(p_payload->>'alias');
  if p_payload->'acceptRules' is distinct from 'true'::jsonb or v_alias is null or char_length(v_alias) not between 3 and 60 or v_alias~'[[:cntrl:]<>@]' or v_alias~'[0-9]{7}' or v_alias~*'https?://' then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
  select * into l from public.group_referral_links where campaign_id=c.id and owner_id=v_user;
  if found and l.alias<>v_alias then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
  insert into public.group_referral_links(campaign_id,owner_id,alias,rules_version) values(c.id,v_user,v_alias,c.rules_version) on conflict(campaign_id,owner_id) do nothing;
 when 'register_group' then
  if c.state<>'open' or v_now not between c.starts_at and c.joins_until then raise exception 'REFERRAL_NOT_OPEN';end if;
  select * into g from public.study_groups where id=(p_payload->>'groupId')::uuid for share;
  if not found or g.representative_id<>v_user then raise exception 'REFERRAL_GROUP_FORBIDDEN' using errcode='42501';end if;
  if g.created_at<c.starts_at then raise exception 'REFERRAL_OLD_GROUP';end if;
  if g.created_at>v_now or v_now>g.created_at+interval '24 hours' then raise exception 'REFERRAL_REGISTRATION_EXPIRED';end if;
  if not public.xelay_private_referral_real_group(g.id) then raise exception 'REFERRAL_GROUP_INELIGIBLE';end if;
  select * into l from public.group_referral_links where campaign_id=c.id and code=upper(btrim(p_payload->>'code'));
  if not found or not public.xelay_private_referral_account(l.owner_id) then raise exception 'REFERRAL_INVALID_CODE';end if;
  if exists(select 1 from public.group_referral_entries where campaign_id=c.id and group_id=g.id) then raise exception 'REFERRAL_GROUP_ALREADY_REGISTERED';end if;
  insert into public.group_referral_entries(campaign_id,group_id,link_id,organizer_id,representative_id,group_created_at,identity_key)
   values(c.id,g.id,l.id,l.owner_id,v_user,g.created_at,public.xelay_private_referral_identity(g.id));
 when 'submit_group','review_group' then
  if c.state<>'open' then raise exception 'REFERRAL_INVALID_STATE';end if;
  select * into e from public.group_referral_entries where id=(p_payload->>'entryId')::uuid and campaign_id=c.id for update;
  if not found or(p_action='submit_group' and v_user not in(e.organizer_id,e.representative_id)) then raise exception 'REFERRAL_GROUP_FORBIDDEN' using errcode='42501';end if;
  if v_version is distinct from e.version then raise exception 'REFERRAL_VERSION_CONFLICT' using errcode='PT409';end if;
  perform 1 from public.study_groups where id=e.group_id for share;
  perform 1 from public.study_group_members where group_id=e.group_id for share;
  perform 1 from auth.users where id in(select user_id from public.group_referral_credits where entry_id=e.id) or id in(e.organizer_id,e.representative_id) order by id for share;
  perform 1 from public.profiles where id in(select user_id from public.group_referral_credits where entry_id=e.id) or id in(e.organizer_id,e.representative_id) order by id for share;
  perform 1 from public.study_group_schedule where group_id=e.group_id order by id for share;
  perform 1 from public.study_group_homework where group_id=e.group_id order by id for share;
  perform 1 from public.study_group_materials where group_id=e.group_id order by id for share;
  if p_action='submit_group' then
   if v_now>c.qualifies_until then raise exception 'REFERRAL_NOT_OPEN';end if;
   if e.state not in('collecting','rejected') then raise exception 'REFERRAL_INVALID_STATE';end if;
   if not(public.xelay_private_referral_progress(e.id,v_user)->>'eligible')::boolean then raise exception 'REFERRAL_GROUP_INELIGIBLE';end if;
   update public.group_referral_entries set state='pending',version=version+1,review_reason=null,reviewed_at=null,reviewed_by=null where id=e.id;
  else
   if p_payload->>'decision' not in('approved','rejected') or p_payload->>'decision' is null then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
   if v_reason is null or char_length(v_reason)<3 then raise exception 'REFERRAL_REASON_REQUIRED';end if;
   if e.state not in('pending','approved') then raise exception 'REFERRAL_INVALID_STATE';end if;
   if p_payload->>'decision'='approved' and not(public.xelay_private_referral_progress(e.id,v_user)->>'eligible')::boolean then raise exception 'REFERRAL_GROUP_INELIGIBLE';end if;
   update public.group_referral_entries set state=p_payload->>'decision',version=version+1,review_reason=v_reason,reviewed_at=v_now,reviewed_by=v_user where id=e.id;
   -- A freeze confirmation must refer to the reviewed set the admin saw.
   update public.group_referral_campaigns set version=version+1 where id=c.id;
  end if;
 when 'save_campaign' then
  if c.state<>'draft' then raise exception 'REFERRAL_INVALID_STATE';end if;
  if p_payload->>'title' is null or char_length(btrim(p_payload->>'title')) not between 3 and 160 or jsonb_typeof(p_payload->'prizes') is distinct from 'array' or jsonb_array_length(p_payload->'prizes')<>3 then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
  for v_rank in 1..3 loop
   v_proof:=p_payload->'prizes'->(v_rank-1);
   if jsonb_typeof(v_proof) is distinct from 'object' or not(v_proof?&array['rank','label','months'])
    or v_proof-array['rank','label','months']<>'{}'::jsonb or jsonb_typeof(v_proof->'rank') is distinct from 'number'
    or(v_proof->>'rank')::integer is distinct from v_rank or v_proof->>'label' is null or char_length(btrim(v_proof->>'label')) not between 3 and 80
    or(v_proof->>'months' is not null and(v_proof->>'months')::integer not between 1 and 24) then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
  end loop;
  update public.group_referral_campaigns set title=btrim(p_payload->>'title'),starts_at=(p_payload->>'startsAt')::timestamptz,joins_until=(p_payload->>'joinsUntil')::timestamptz,
   qualifies_until=(p_payload->>'qualifiesUntil')::timestamptz,draw_at=(p_payload->>'drawAt')::timestamptz,prizes=p_payload->'prizes',version=version+1 where id=c.id;
 when 'activate_campaign' then
  if c.state<>'draft' then raise exception 'REFERRAL_INVALID_STATE';end if;
  if c.starts_at is null or c.joins_until is null or c.qualifies_until is null or c.draw_at is null or not isfinite(c.starts_at) or not isfinite(c.joins_until) or not isfinite(c.qualifies_until) or not isfinite(c.draw_at)
   or c.starts_at>=c.joins_until or c.joins_until<=v_now or c.qualifies_until<c.joins_until or c.draw_at<c.qualifies_until
   or exists(select 1 from jsonb_array_elements(c.prizes) p where p->>'months' is null or(p->>'months')::integer not between 1 and 24) then raise exception 'REFERRAL_CAMPAIGN_INCOMPLETE';end if;
  update public.group_referral_campaigns set state='open',version=version+1 where id=c.id;
 when 'freeze_entries' then
  if c.state<>'open' then raise exception 'REFERRAL_INVALID_STATE';end if;
  if p_payload->'confirm' is distinct from 'true'::jsonb then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
  if v_now<c.qualifies_until then raise exception 'REFERRAL_TOO_EARLY';end if;
  -- Protect current membership and resources against concurrent review/freeze races.
  perform 1 from public.study_groups where id in(select group_id from public.group_referral_entries where campaign_id=c.id) order by id for share;
  perform 1 from public.study_group_members where group_id in(select group_id from public.group_referral_entries where campaign_id=c.id) order by id for share;
  perform 1 from auth.users where id in(select user_id from public.group_referral_credits where campaign_id=c.id)
   or id in(select organizer_id from public.group_referral_entries where campaign_id=c.id)
   or id in(select representative_id from public.group_referral_entries where campaign_id=c.id) order by id for share;
  perform 1 from public.profiles where id in(select user_id from public.group_referral_credits where campaign_id=c.id)
   or id in(select organizer_id from public.group_referral_entries where campaign_id=c.id)
   or id in(select representative_id from public.group_referral_entries where campaign_id=c.id) order by id for share;
  perform 1 from public.study_group_schedule where group_id in(select group_id from public.group_referral_entries where campaign_id=c.id) order by id for share;
  perform 1 from public.study_group_homework where group_id in(select group_id from public.group_referral_entries where campaign_id=c.id) order by id for share;
  perform 1 from public.study_group_materials where group_id in(select group_id from public.group_referral_entries where campaign_id=c.id) order by id for share;
  if exists(select 1 from public.group_referral_entries ent where ent.campaign_id=c.id and ent.state='approved' and not(public.xelay_private_referral_progress(ent.id,v_user)->>'eligible')::boolean) then raise exception 'REFERRAL_GROUP_INELIGIBLE';end if;
  select count(distinct organizer_id) into v_count from public.group_referral_entries where campaign_id=c.id and state='approved';
  if v_count<3 then raise exception 'REFERRAL_NEED_THREE_ORGANIZERS';end if;
  insert into public.group_referral_snapshots(campaign_id,entry_id,organizer_id,alias,proof)
   select c.id,ent.id,ent.organizer_id,lnk.alias,public.xelay_private_referral_progress(ent.id,null) from public.group_referral_entries ent join public.group_referral_links lnk on lnk.id=ent.link_id where ent.campaign_id=c.id and ent.state='approved';
  select jsonb_agg(jsonb_build_object('entryId',entry_id,'organizerId',organizer_id,'alias',alias,'proof',proof) order by entry_id) into v_snapshot from public.group_referral_snapshots where campaign_id=c.id;
  update public.group_referral_campaigns set state='frozen',frozen_at=v_now,snapshot_hash=encode(extensions.digest(v_snapshot::text,'sha256'),'hex'),version=version+1 where id=c.id;
 when 'draw_winners' then
  if c.state in('drawn','published') then raise exception 'REFERRAL_ALREADY_DRAWN';end if;
  if c.state<>'frozen' then raise exception 'REFERRAL_INVALID_STATE';end if;
  if p_payload->'confirm' is distinct from 'true'::jsonb then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
  if v_now<c.draw_at then raise exception 'REFERRAL_TOO_EARLY';end if;
  insert into public.group_referral_draw_orders(campaign_id,entry_id) select c.id,entry_id from public.group_referral_snapshots where campaign_id=c.id;
  for v_rank in 1..3 loop
   select s.organizer_id,s.alias into v_id,v_alias from public.group_referral_snapshots s join public.group_referral_draw_orders d on d.campaign_id=s.campaign_id and d.entry_id=s.entry_id
    where s.campaign_id=c.id and not exists(select 1 from public.group_referral_winners win where win.campaign_id=c.id and win.organizer_id=s.organizer_id) order by d.random_key,s.entry_id limit 1;
   if not found then raise exception 'REFERRAL_NEED_THREE_ORGANIZERS';end if;
   insert into public.group_referral_winners(campaign_id,organizer_id,rank,alias,prize) values(c.id,v_id,v_rank,v_alias,c.prizes->(v_rank-1));
  end loop;
  update public.group_referral_campaigns set state='drawn',drawn_at=v_now,version=version+1 where id=c.id;
 when 'publish_results' then
  if c.state<>'drawn' then raise exception 'REFERRAL_INVALID_STATE';end if;
  if p_payload->'confirm' is distinct from 'true'::jsonb then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
  update public.group_referral_campaigns set state='published',published_at=v_now,version=version+1 where id=c.id;
  -- Existing notification triggers retain normal per-channel opt-outs. No promotional batch or provider call.
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read)
   select organizer_id,v_user,'Xelay','group_referral_result',format('Ви серед переможців «%s»: місце %s. Перегляньте результати у Xelay.',c.title,rank),false from public.group_referral_winners
   where campaign_id=c.id and not exists(select 1 from public.notification_preferences p where p.user_id=organizer_id
    and(not coalesce(p.notifications_enabled,true) or not coalesce((to_jsonb(p)->'category_settings'->'community'->>'in_app')::boolean,true)));
 when 'set_prize_status','set_interview_status' then
  if c.state<>'published' then raise exception 'REFERRAL_INVALID_STATE';end if;
  select * into w from public.group_referral_winners where id=(p_payload->>'winnerId')::uuid and campaign_id=c.id for update;
  if not found then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
  if v_version is distinct from w.version then raise exception 'REFERRAL_VERSION_CONFLICT' using errcode='PT409';end if;
  if v_reason is null or char_length(v_reason)<3 then raise exception 'REFERRAL_REASON_REQUIRED';end if;
  if p_action='set_prize_status' then
   if p_payload->>'prizeStatus' not in('pending','issued') or p_payload->>'prizeStatus' is null then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
   update public.group_referral_winners set prize_status=p_payload->>'prizeStatus',version=version+1 where id=w.id;
  else
   if p_payload->>'interviewStatus' not in('pending','invited','declined','completed') or p_payload->>'interviewStatus' is null then raise exception 'REFERRAL_INVALID_PAYLOAD';end if;
   update public.group_referral_winners set interview_status=p_payload->>'interviewStatus',version=version+1 where id=w.id;
  end if;
 end case;
 insert into public.group_referral_commands(campaign_id,request_id,actor_id,action,payload_hash) values(c.id,v_request,v_user,p_action,v_hash);
 insert into public.group_referral_audit(campaign_id,actor_id,action,target,reason) values(c.id,v_user,p_action,coalesce(nullif(p_payload->>'entryId','')::uuid,nullif(p_payload->>'winnerId','')::uuid,nullif(p_payload->>'groupId','')::uuid),v_reason);
 return public.xelay_group_referral_workspace(c.slug);
end$$;

-- Private evidence and attribution never have a browser/table write surface.
-- Frozen evidence cannot be rewritten even accidentally by a future RPC.
create function public.xelay_guard_referral_immutable() returns trigger language plpgsql set search_path='' as $$begin raise exception 'REFERRAL_IMMUTABLE';end$$;
create trigger group_referral_snapshot_immutable before update or delete on public.group_referral_snapshots for each row execute function public.xelay_guard_referral_immutable();
create trigger group_referral_draw_order_immutable before update or delete on public.group_referral_draw_orders for each row execute function public.xelay_guard_referral_immutable();
create trigger group_referral_link_immutable before update or delete on public.group_referral_links for each row execute function public.xelay_guard_referral_immutable();
create trigger group_referral_credit_immutable before update or delete on public.group_referral_credits for each row execute function public.xelay_guard_referral_immutable();
create function public.xelay_guard_referral_campaign_config() returns trigger language plpgsql set search_path='' as $$begin
 if old.state<>'draft' and (new.title,new.slug,new.starts_at,new.joins_until,new.qualifies_until,new.draw_at,new.minimum_students,new.prizes,new.rules_version)
  is distinct from(old.title,old.slug,old.starts_at,old.joins_until,old.qualifies_until,old.draw_at,old.minimum_students,old.prizes,old.rules_version) then raise exception 'REFERRAL_IMMUTABLE';end if;
 if old.snapshot_hash is not null and (new.snapshot_hash,new.frozen_at) is distinct from(old.snapshot_hash,old.frozen_at) then raise exception 'REFERRAL_IMMUTABLE';end if;
 if old.drawn_at is not null and new.drawn_at is distinct from old.drawn_at then raise exception 'REFERRAL_IMMUTABLE';end if;
 if old.published_at is not null and new.published_at is distinct from old.published_at then raise exception 'REFERRAL_IMMUTABLE';end if;
 return new;
end$$;
create trigger group_referral_campaign_config_immutable before update on public.group_referral_campaigns for each row execute function public.xelay_guard_referral_campaign_config();
do $$declare p record;begin
 for p in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and(proname like 'xelay_private_referral_%' or proname in('xelay_guard_referral_campaign_config','xelay_guard_referral_immutable','xelay_group_referral_workspace','xelay_group_referral_action','xelay_group_referral_observe_read')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);
 end loop;
end$$;
grant execute on function public.xelay_group_referral_workspace(text,uuid,uuid,uuid) to anon,authenticated;
grant execute on function public.xelay_group_referral_action(text,jsonb,uuid),public.xelay_group_referral_observe_read(uuid,text,uuid,uuid) to authenticated;
insert into public.group_referral_campaigns(slug) values('bring-your-group');
notify pgrst,'reload schema';
commit;
