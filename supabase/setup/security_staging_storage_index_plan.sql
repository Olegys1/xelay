-- READ ONLY: managed Storage index definitions and estimated plans only.
-- Intended Dashboard: test1 / saufzpryybuawudohhwj. Verify the target in the UI.
-- One JSON result. No object rows, names, bytes, credentials, trigger args,
-- mutations, EXPLAIN ANALYZE, DDL, temporary tables or functions are executed.
-- DO stores plan JSON only in transaction-local session settings.
begin transaction read only;
set local statement_timeout='15s';
set local lock_timeout='2s';

do $$
declare
  v_bucket text;
  v_plan jsonb;
  v_plans jsonb:='[]';
  v_live_sql text:='';
  v_has_versioned boolean;
  v_has_archived boolean;
  v_bucket_att smallint; v_name_att smallint;
  v_c_index boolean; v_null_index boolean; v_current_index boolean; v_name_expr text;
begin
  if to_regclass('storage.objects') is null then raise exception 'Managed Storage objects missing'; end if;
  if (coalesce(current_setting('app.settings.supabase_url',true),'')
    ||coalesce(current_setting('api.external_url',true),'')) like '%baohfpadxvhqhhjjqtil%' then
    raise exception 'Known production target refused';
  end if;
  select exists(select 1 from pg_attribute where attrelid='storage.objects'::regclass and attname='is_versioned' and not attisdropped),
    exists(select 1 from pg_attribute where attrelid='storage.objects'::regclass and attname='archived_at' and not attisdropped)
    into v_has_versioned,v_has_archived;
  select attnum into v_bucket_att from pg_attribute where attrelid='storage.objects'::regclass and attname='bucket_id';
  select attnum into v_name_att from pg_attribute where attrelid='storage.objects'::regclass and attname='name';
  select coalesce(bool_or(true),false),
    coalesce(bool_or(i.indisunique and regexp_replace(pg_get_expr(i.indpred,i.indrelid),'[[:space:]()]','','g')='NOTis_versioned'),false),
    coalesce(bool_or(i.indisunique and regexp_replace(pg_get_expr(i.indpred,i.indrelid),'[[:space:]()]','','g')='archived_atISNULL'),false)
    into v_c_index,v_null_index,v_current_index from pg_index i join pg_class c on c.oid=i.indexrelid
      join pg_am a on a.oid=c.relam where i.indrelid='storage.objects'::regclass and i.indisvalid and i.indisready
      and a.amname='btree' and i.indkey[0]=v_bucket_att and i.indkey[1]=v_name_att
      and i.indcollation[1]='pg_catalog."C"'::regcollation;
  v_name_expr:=case when v_c_index then 'o.name collate "C"' else 'o.name' end;
  if v_c_index and v_null_index and v_has_versioned then v_live_sql:=' and not o.is_versioned';
  elsif v_c_index and v_current_index and v_has_archived then v_live_sql:=' and o.archived_at is null'; end if;
  foreach v_bucket in array array['avatars','answer-media','question-images','xelay-message-media','xelay-chat-media'] loop
    -- Exact migration011 shape: record it even when the empty-table planner
    -- chooses a cheap Seq Scan; do not force a favorable plan with settings.
    execute format('explain (format json) select o.* from storage.objects o where o.bucket_id=%L
      and o.name>'''' order by o.name limit 66',v_bucket) into v_plan;
    v_plans:=v_plans||jsonb_build_array(jsonb_build_object('bucket_id',v_bucket,'shape','migration011',
      'plan',v_plan,'estimated_only',true));
    -- Exact migration012 page: use one matching partial predicate before the
    -- LIMIT; other version flags, age/references/claims are evaluated after
    -- this bounded page. Legacy schemas keep their original name ordering.
    execute format('explain (format json) select o.* from storage.objects o where o.bucket_id=%L
      and %s>''''%s%s order by %s limit 66',v_bucket,v_name_expr,
      case when v_c_index then ' collate "C"' else '' end,v_live_sql,v_name_expr) into v_plan;
    v_plans:=v_plans||jsonb_build_array(jsonb_build_object('bucket_id',v_bucket,'shape','migration012',
      'plan',v_plan,'estimated_only',true,'C_name_index',v_c_index,'indexed_page_predicate',v_live_sql));
  end loop;
  perform set_config('xelay.security_storage_index_plans',v_plans::text,true);
end $$;

select jsonb_build_object(
  'intended_target','saufzpryybuawudohhwj','postgres_version',current_setting('server_version'),
  'sql_role',current_user,'read_only',current_setting('transaction_read_only')='on',
  'objects_owner',(select pg_get_userbyid(relowner) from pg_class where oid='storage.objects'::regclass),
  'name_collation',(select a.attcollation::regcollation::text from pg_attribute a where a.attrelid='storage.objects'::regclass and a.attname='name'),
  'versioning_columns',(select coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull) order by a.attnum),'[]')
    from pg_attribute a where a.attrelid='storage.objects'::regclass and a.attname in('archived_at','is_versioned','is_delete_marker') and not a.attisdropped),
  'indexes',(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'unique',i.indisunique,'valid',i.indisvalid,
      'ready',i.indisready,'definition',pg_get_indexdef(i.indexrelid),'predicate',pg_get_expr(i.indpred,i.indrelid)) order by c.relname),'[]')
    from pg_index i join pg_class c on c.oid=i.indexrelid where i.indrelid='storage.objects'::regclass),
  'plans',current_setting('xelay.security_storage_index_plans')::jsonb,
  'interpretation','Estimated plans only. SeqScan on an empty/tiny table is reasonable; inspect partial predicates and C collation before claiming bounded indexed scans at scale.'
) as security_storage_index_plan;
rollback;
