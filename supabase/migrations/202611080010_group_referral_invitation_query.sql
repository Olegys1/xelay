-- Canonical referral invitations use ?ref=; ?code= belongs to Auth callbacks.
-- Only the existing workspace projection changes. No campaign data is written.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $preflight$
declare v_proc pg_catalog.pg_proc%rowtype;v_hash text;
begin
 select * into v_proc from pg_catalog.pg_proc where oid=to_regprocedure('public.xelay_group_referral_workspace(text,uuid,uuid,uuid)');
 if not found or v_proc.prorettype<>'jsonb'::regtype or not v_proc.prosecdef or v_proc.provolatile<>'s'
  or not coalesce('search_path=""'=any(v_proc.proconfig),false) then
  raise exception 'REFERRAL_INVITATION_QUERY_PREREQUISITES_CHANGED';end if;
 v_hash:=encode(extensions.digest(replace(v_proc.prosrc,chr(13),''),'sha256'),'hex');
 if v_hash not in('6c9aa11cd269d6850a2fba6600493c374b9fe1efac813ff34992049ddc5fc3ca','e6e6f44ea143991b9003c40c49465001aa6579441087e91d9f6f8eead12fabee') then
  raise exception 'REFERRAL_INVITATION_QUERY_SOURCE_CHANGED';end if;
end $preflight$;

create or replace function public.xelay_group_referral_workspace(p_slug text default 'bring-your-group',p_after uuid default null,p_admin_after uuid default null,p_candidate_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.group_referral_campaigns%rowtype;v_user uuid:=auth.uid();v_admin boolean:=false;v_own jsonb:='[]';v_admin_groups jsonb:='[]';v_candidates jsonb:='[]';v_link jsonb;v_winners jsonb:='[]';v_next uuid;v_admin_next uuid;v_candidate_next uuid;v_tickets integer:=0;v_approved integer:=0;v_organizers integer:=0;v_audit jsonb:='[]';
begin
 select * into c from public.group_referral_campaigns where slug=p_slug;
 if not found then return jsonb_build_object('campaign',null,'actor',null,'ownLink',null,'ownGroups','[]'::jsonb,'candidateGroups','[]'::jsonb,'ownTickets',0,'winners','[]'::jsonb);end if;
 if v_user is not null and auth.role()='authenticated' then v_admin:=public.xelay_private_referral_admin();else v_user:=null;end if;
 if v_user is not null then
  select jsonb_build_object('code',code,'path','/referrals?ref='||code) into v_link from public.group_referral_links where campaign_id=c.id and owner_id=v_user;
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

notify pgrst,'reload schema';
commit;
