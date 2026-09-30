-- Manual complimentary group access. Run in Supabase SQL Editor.
-- Matches ЕУБ-4 / ЕУБ - 4; stops if the name is missing or ambiguous.
-- Repeated execution preserves active access and does not duplicate the grant.

begin;

do $$
declare
  v_ids uuid[];
  v_group_id uuid;
  v_previous jsonb;
  v_granted uuid;
begin
  select array_agg(id) into v_ids
  from public.study_groups
  where regexp_replace(upper(group_name), '[[:space:]‐‑‒–—−-]', '', 'g') = 'ЕУБ4';

  if coalesce(cardinality(v_ids), 0) <> 1 then
    raise exception 'Знайдено % груп ЕУБ-4. Потрібна рівно одна група.',
      coalesce(cardinality(v_ids), 0);
  end if;

  v_group_id := v_ids[1];
  perform 1 from public.study_groups where id = v_group_id for update;
  if not found then
    raise exception 'Групу вже видалено. Оновіть список груп.';
  end if;

  select to_jsonb(e) into v_previous
  from public.group_entitlements e
  where e.group_id = v_group_id
  for update;

  insert into public.group_entitlements(group_id, source)
  values (v_group_id, 'admin_grant')
  on conflict (group_id) do update
    set source = 'admin_grant',
        order_id = null,
        revoked_at = null,
        created_at = now()
    where group_entitlements.revoked_at is not null
  returning group_id into v_granted;

  if v_granted is not null then
    insert into public.billing_audit_log(actor_id, action, group_id, detail)
    values (auth.uid(), 'grant_group', v_group_id, jsonb_build_object(
      'reason', 'Безкоштовний доступ для ЕУБ-4 за рішенням власника Xelay',
      'source', 'supabase_sql_editor',
      'previous_entitlement', v_previous
    ));
  end if;
end;
$$;

commit;
