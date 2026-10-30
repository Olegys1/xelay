-- Activate five additional automatic Halloween rewards for NEW completions.
-- Existing completed accounts receive no historical award, notification or email.
-- New RPC requests after this transaction commits use slots 11..15. An invocation
-- already executing the old function body may finish under the previous rules.
-- Replaying this migration never changes campaign data or issues a reward.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $migration$
declare
  v_claimed smallint;
  v_item record;
  v_definition text;
  v_expected text;
  v_acl aclitem[];
  v_owner oid;
  v_old_count integer;
  v_new_count integer;
  v_function_mode text;
  v_mode text;
begin
  if to_regclass('public.halloween_2026_campaign') is null
    or to_regclass('public.halloween_2026_rewards') is null
    or to_regprocedure('public.xelay_my_halloween_hunt()') is null
    or to_regprocedure('public.xelay_collect_halloween_pumpkin(text)') is null then
    raise exception 'HALLOWEEN_EXTRA_REWARDS_PREREQUISITES_MISSING';
  end if;

  -- Drain transactions already writing pickups before taking campaign locks.
  lock table public.halloween_2026_collections in share row exclusive mode;
  lock table public.halloween_2026_campaign,public.halloween_2026_rewards in access exclusive mode;

  -- The existing permanent counter is retained, including any deleted winners.
  -- Serializes activation with completions that already reached the campaign row.
  select winners_claimed into v_claimed
    from public.halloween_2026_campaign where singleton for update;
  if v_claimed is null or v_claimed not between 10 and 15 then
    raise exception 'HALLOWEEN_EXTRA_REWARDS_UNEXPECTED_COUNTER';
  end if;
  if exists(select 1 from public.halloween_2026_rewards where subscription_slot>v_claimed) then
    raise exception 'HALLOWEEN_EXTRA_REWARDS_SLOT_COUNTER_MISMATCH';
  end if;

  for v_item in select * from (values
    ('public.halloween_2026_campaign'::regclass,
      'halloween_2026_campaign_winners_claimed_check',
      'CHECK (((winners_claimed >= 0) AND (winners_claimed <= 10)))',
      'CHECK (((winners_claimed >= 0) AND (winners_claimed <= 15)))'),
    ('public.halloween_2026_rewards'::regclass,
      'halloween_2026_rewards_subscription_slot_check',
      'CHECK (((subscription_slot >= 1) AND (subscription_slot <= 10)))',
      'CHECK (((subscription_slot >= 1) AND (subscription_slot <= 15)))')
  ) as checks(table_id,constraint_name,old_definition,new_definition)
  loop
    select pg_catalog.pg_get_constraintdef(c.oid) into v_definition
      from pg_catalog.pg_constraint c where c.conrelid=v_item.table_id
        and c.conname=v_item.constraint_name and c.contype='c' and c.convalidated;
    if v_definition=v_item.old_definition then
      execute format('alter table %s drop constraint %I',v_item.table_id,v_item.constraint_name);
      execute format('alter table %s add constraint %I %s',v_item.table_id,v_item.constraint_name,v_item.new_definition);
    elsif v_definition is distinct from v_item.new_definition then
      raise exception 'HALLOWEEN_EXTRA_REWARDS_UNEXPECTED_CONSTRAINT: %',v_item.constraint_name;
    end if;
  end loop;

  -- Read the installed definitions rather than replacing them with a stale copy.
  -- Exact one-occurrence edits retain every unrelated production-body change.
  for v_item in select * from (values
    ('public.xelay_my_halloween_hunt()'::regprocedure,
      '''winnersRemaining'',10-campaign.winners_claimed',
      '''winnersRemaining'',15-campaign.winners_claimed'),
    ('public.xelay_collect_halloween_pumpkin(text)'::regprocedure,
      'if v_claimed<10 then','if v_claimed<15 then')
  ) as functions(function_id,old_token,new_token)
  loop
    select pg_catalog.pg_get_functiondef(p.oid),p.proacl,p.proowner
      into v_definition,v_acl,v_owner from pg_catalog.pg_proc p
      where p.oid=v_item.function_id and p.prosecdef
        and p.proconfig=array['search_path=""']::text[];
    if v_definition is null then raise exception 'HALLOWEEN_EXTRA_REWARDS_UNEXPECTED_RPC_SECURITY'; end if;
    v_old_count:=(length(v_definition)-length(replace(v_definition,v_item.old_token,'')))/length(v_item.old_token);
    v_new_count:=(length(v_definition)-length(replace(v_definition,v_item.new_token,'')))/length(v_item.new_token);
    if v_old_count=1 and v_new_count=0 then
      v_mode:='old';
      v_definition:=replace(v_definition,v_item.old_token,v_item.new_token);
    elsif v_old_count=0 and v_new_count=1 then
      v_mode:='new';
    else
      raise exception 'HALLOWEEN_EXTRA_REWARDS_UNEXPECTED_RPC_TOKEN: %',v_item.function_id;
    end if;
    if v_function_mode is not null and v_function_mode<>v_mode then
      raise exception 'HALLOWEEN_EXTRA_REWARDS_INCONSISTENT_RPC_VERSION';
    end if;
    v_function_mode:=v_mode;

    if v_item.function_id='public.xelay_collect_halloween_pumpkin(text)'::regprocedure then
      v_expected:='Перші 10 подарункових підписок уже розібрали, але ваш бейдж залишиться з вами.';
      v_old_count:=(length(v_definition)-length(replace(v_definition,v_expected,'')))/length(v_expected);
      v_new_count:=(length(v_definition)-length(replace(v_definition,
        'Подарункові підписки нової хвилі вже розібрали, але ваш бейдж залишиться з вами.','')))
        /length('Подарункові підписки нової хвилі вже розібрали, але ваш бейдж залишиться з вами.');
      if v_mode='old' and v_old_count=1 and v_new_count=0 then
        v_definition:=replace(v_definition,v_expected,
          'Подарункові підписки нової хвилі вже розібрали, але ваш бейдж залишиться з вами.');
      elsif not(v_mode='new' and v_old_count=0 and v_new_count=1) then
        raise exception 'HALLOWEEN_EXTRA_REWARDS_UNEXPECTED_NOTIFICATION_COPY';
      end if;
    end if;
    execute v_definition;
    if exists(select 1 from pg_catalog.pg_proc where oid=v_item.function_id
      and (proacl is distinct from v_acl or proowner is distinct from v_owner)) then
      raise exception 'HALLOWEEN_EXTRA_REWARDS_RPC_PERMISSIONS_CHANGED';
    end if;
  end loop;
end
$migration$;
commit;
