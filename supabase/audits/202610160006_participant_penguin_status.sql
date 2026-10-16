-- READ-ONLY: run before and after migration 006. No preference text, contact
-- details or individual user identifiers are returned. Concurrent legitimate
-- edits may change an aggregate hash independently of this migration.
begin transaction isolation level repeatable read read only;

with relation_audit as (
select 'premium_preferences' as relation,count(*) as row_count,
  md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' order by p.user_id::text),'')) as aggregate_row_hash
from public.premium_preferences p
union all
select 'participant_entitlements',count(*),
  md5(coalesce(string_agg(md5(to_jsonb(e)::text),'' order by e.id::text),''))
from public.participant_entitlements e
union all
select 'profiles',count(*),
  md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' order by p.id::text),''))
from public.profiles p
), setter_audit as (

select p.oid::regprocedure::text as signature,pg_get_userbyid(p.proowner) as owner,
  p.proacl::text as execution_acl,p.prosecdef as security_definer,p.proconfig,
  md5(p.prosrc) as implementation_hash,
  position('''sticker:penguin''' in p.prosrc)>0 as allows_penguin,
  position('if v_user_id is null then' in p.prosrc)>0 as authentication_guard,
  position('not public.xelay_has_participant_access(v_user_id)' in p.prosrc)>0 as premium_guard,
  position('char_length(v_text) > 48' in p.prosrc)>0 as text_limit_48,
  position('cardinality(v_tokens) > 3' in p.prosrc)>0 as emoji_limit_3,
  position('count(distinct t.emoji)' in p.prosrc)>0 as unique_emoji_guard
from pg_catalog.pg_proc p
where p.oid=to_regprocedure('public.xelay_set_participant_status(text,text)')
)
select jsonb_build_object(
  'relations',(select jsonb_agg(to_jsonb(r) order by r.relation) from relation_audit r),
  'setter',(select to_jsonb(s) from setter_audit s)
) as audit;

rollback;
