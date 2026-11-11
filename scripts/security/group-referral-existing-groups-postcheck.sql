-- Read-only before/after rollout evidence. Results contain only aggregate counts,
-- timestamps, source hashes and whole-table fingerprints; no names or codes.
with campaign as (
 select c.* from public.group_referral_campaigns c where c.slug='bring-your-group'
), candidates as (
 select g.created_at,c.starts_at,
  c.state='open' and statement_timestamp() between c.starts_at and c.joins_until
   and g.created_at<=statement_timestamp() and public.xelay_private_referral_real_group(g.id) eligible
 from public.study_groups g cross join campaign c
 where not exists(select 1 from public.group_referral_entries e where e.campaign_id=c.id and e.group_id=g.id)
), progress as (
 select e.state,public.xelay_private_referral_progress(e.id,null) proof
 from public.group_referral_entries e join campaign c on c.id=e.campaign_id
), fingerprints as (
 select 'campaigns' dataset,count(*) records,encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]'),'sha256'),'hex') sha256 from public.group_referral_campaigns t
 union all select 'links',count(*),encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]'),'sha256'),'hex') from public.group_referral_links t
 union all select 'entries',count(*),encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]'),'sha256'),'hex') from public.group_referral_entries t
 union all select 'credits',count(*),encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by t.campaign_id,t.user_id)::text,'[]'),'sha256'),'hex') from public.group_referral_credits t
 union all select 'reads',count(*),encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]'),'sha256'),'hex') from public.group_referral_reads t
 union all select 'snapshots',count(*),encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by t.campaign_id,t.entry_id)::text,'[]'),'sha256'),'hex') from public.group_referral_snapshots t
 union all select 'draw_orders',count(*),encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by t.campaign_id,t.entry_id)::text,'[]'),'sha256'),'hex') from public.group_referral_draw_orders t
 union all select 'winners',count(*),encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]'),'sha256'),'hex') from public.group_referral_winners t
 union all select 'commands',count(*),encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by t.campaign_id,t.request_id)::text,'[]'),'sha256'),'hex') from public.group_referral_commands t
 union all select 'audit',count(*),encode(extensions.digest(coalesce(jsonb_agg(to_jsonb(t) order by t.id)::text,'[]'),'sha256'),'hex') from public.group_referral_audit t
)
select c.slug,c.state,c.version,c.starts_at,c.joins_until,c.qualifies_until,c.draw_at,c.minimum_students,c.rules_version,
 (select count(*) from candidates where eligible) eligible_unregistered_groups,
 (select count(*) from candidates where eligible and created_at<starts_at) eligible_groups_created_before_campaign,
 (select count(*) from candidates where eligible and created_at<=statement_timestamp()-interval '24 hours') eligible_groups_older_than_24h,
 (select count(*) from progress) registered_groups,
 (select count(*) from progress where state='approved') approved_groups,
 (select count(*) from progress where state='approved' and (proof->>'eligible')::boolean) eligible_approved_tickets,
 (select count(*) from progress where proof->'issues'?'old_or_changed_group') changed_creation_timestamp_groups,
 (select jsonb_object_agg(dataset,jsonb_build_object('records',records,'sha256',sha256)) from fingerprints) stored_data_fingerprints,
 (select jsonb_object_agg(p.oid::regprocedure::text,encode(extensions.digest(replace(p.prosrc,chr(13),''),'sha256'),'hex'))
  from pg_catalog.pg_proc p where p.oid=any(array[
   'public.xelay_group_referral_action(text,jsonb,uuid)'::regprocedure,
   'public.xelay_group_referral_workspace(text,uuid,uuid,uuid)'::regprocedure,
   'public.xelay_private_referral_progress(uuid,uuid)'::regprocedure])) function_sha256
from campaign c;
