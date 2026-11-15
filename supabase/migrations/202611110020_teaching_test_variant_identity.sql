-- Persist the authored set chosen for an attempt. Definitions and set names
-- stay staff-only; the student continues receiving only their issued snapshot.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.teaching_test_variant_labels (
  test_id uuid primary key references public.teaching_tests(id) on delete cascade,
  base_title text not null check(length(btrim(base_title)) between 1 and 120)
);
alter table public.teaching_test_variant_labels enable row level security;
revoke all on public.teaching_test_variant_labels from public,anon,authenticated,service_role;

alter table public.teaching_test_attempts
  add column variant_id text,
  add column variant_number integer,
  add column variant_title text,
  add constraint teaching_test_attempt_variant_identity check (
    (variant_id is null and variant_number is null and variant_title is null)
    or (variant_number is not null and variant_number >= 1 and variant_title is not null and length(btrim(variant_title)) between 1 and 120
      and ((variant_number = 1 and variant_id is null)
        or (variant_number > 1 and variant_id is not null and variant_id ~ '^[A-Za-z0-9_-]{1,64}$')))
  );

create function public.xelay_private_test_variant_identity(p_test public.teaching_tests,p_attempt uuid,p_issued jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  variants jsonb;
  chosen jsonb;
  source_questions jsonb := p_test.questions;
  set_index integer := 0;
  base_title text;
begin
  select v.variants into variants from public.teaching_test_manual_variants v where v.test_id = p_test.id;
  if variants is not null then
    -- This is exactly the original manual-variant salt and unsigned 32-bit hash.
    set_index := (('x' || substr(md5(p_attempt::text || ':manual-variant'),1,8))::bit(32)::bigint
      % (jsonb_array_length(variants)::bigint + 1))::integer;
    if set_index > 0 then
      chosen := variants->(set_index - 1);
      source_questions := chosen->'questions';
    end if;
  end if;
  -- draw_count, question/option shuffling and calculated/bank question copies
  -- keep question IDs. Check membership rather than comparing shuffled text.
  if jsonb_typeof(p_issued) is distinct from 'array'
    or jsonb_typeof(source_questions) is distinct from 'array'
    or jsonb_array_length(p_issued) <> least(coalesce(p_test.draw_count,jsonb_array_length(source_questions)),jsonb_array_length(source_questions))
    or (select count(distinct q->>'id') from jsonb_array_elements(p_issued) q) <> jsonb_array_length(p_issued)
    or exists (
      select 1 from jsonb_array_elements(p_issued) q
      where not exists(select 1 from jsonb_array_elements(source_questions) source where source->>'id' = q->>'id')
    ) then return null; end if;
  select labels.base_title into base_title from public.teaching_test_variant_labels labels where labels.test_id = p_test.id;
  return jsonb_build_object(
    'variant_id',case when set_index > 0 then chosen->>'id' end,
    'variant_number',set_index + 1,
    'variant_title',case when set_index > 0 then chosen->>'title' else coalesce(base_title,'Варіант 1') end
  );
end;
$$;

-- A legacy snapshot that no longer matches its immutable source is deliberately
-- left unnamed, rather than attributing it to an unrelated authored variant.
with identities as (
  select a.id,public.xelay_private_test_variant_identity(t,a.id,a.questions) identity
  from public.teaching_test_attempts a join public.teaching_tests t on t.id = a.test_id
)
update public.teaching_test_attempts a set
  variant_id = i.identity->>'variant_id',
  variant_number = (i.identity->>'variant_number')::integer,
  variant_title = i.identity->>'variant_title'
from identities i where a.id = i.id and i.identity is not null;

create function public.xelay_private_test_variant_identity_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare test_row public.teaching_tests%rowtype; identity jsonb;
begin
  if tg_op = 'UPDATE' then
    if (new.variant_id,new.variant_number,new.variant_title) is distinct from (old.variant_id,old.variant_number,old.variant_title) then
      raise exception 'TEST_VARIANT_IMMUTABLE' using errcode = '22023';
    end if;
    return new;
  end if;
  select * into test_row from public.teaching_tests where id = new.test_id;
  identity := public.xelay_private_test_variant_identity(test_row,new.id,new.questions);
  if identity is null then raise exception 'TEST_VARIANT_SNAPSHOT_MISMATCH' using errcode = '22023'; end if;
  new.variant_id := identity->>'variant_id';
  new.variant_number := (identity->>'variant_number')::integer;
  new.variant_title := identity->>'variant_title';
  return new;
end;
$$;
create trigger teaching_test_variant_identity_guard
  before insert or update of variant_id,variant_number,variant_title on public.teaching_test_attempts
  for each row execute function public.xelay_private_test_variant_identity_guard();

alter function public.xelay_private_test_view(public.teaching_tests,uuid,boolean)
  rename to xelay_private_test_view_before_variant_identity;
create function public.xelay_private_test_view(p_test public.teaching_tests,p_user uuid,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; base_title text;
begin
  result := public.xelay_private_test_view_before_variant_identity(p_test,p_user,p_full);
  if p_full then
    select labels.base_title into base_title from public.teaching_test_variant_labels labels where labels.test_id = p_test.id;
    return result || jsonb_build_object('base_variant_title',coalesce(base_title,'Варіант 1'));
  end if;
  return result - 'base_variant_title';
end;
$$;

alter function public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean)
  rename to xelay_private_test_attempt_view_before_variant_identity;
create function public.xelay_private_test_attempt_view(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  result := public.xelay_private_test_attempt_view_before_variant_identity(p_attempt,p_test,p_full);
  if p_full then
    return result || jsonb_build_object('variant_id',p_attempt.variant_id,'variant_number',p_attempt.variant_number,'variant_title',p_attempt.variant_title);
  end if;
  return result - array['variant_id','variant_number','variant_title'];
end;
$$;

alter function public.xelay_teaching_test_mutate(text,jsonb)
  rename to xelay_private_test_mutate_before_variant_identity;
create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; test_id uuid;
begin
  if p_action is distinct from 'save_test' then
    return public.xelay_private_test_mutate_before_variant_identity(p_action,p_payload);
  end if;
  -- Existing authorization, version/attempt immutability and shared course lock
  -- run first. Invalid title input rolls back that save in the same transaction.
  result := public.xelay_private_test_mutate_before_variant_identity(p_action,p_payload - 'base_variant_title');
  if p_payload ? 'base_variant_title' then
    if jsonb_typeof(p_payload->'base_variant_title') is distinct from 'string'
      or length(btrim(p_payload->>'base_variant_title')) not between 1 and 120 then
      raise exception 'TEST_INVALID_INPUT' using errcode = '22023';
    end if;
    test_id := (p_payload->>'id')::uuid;
    insert into public.teaching_test_variant_labels(test_id,base_title)
      values(test_id,btrim(p_payload->>'base_variant_title'))
      on conflict on constraint teaching_test_variant_labels_pkey do update set base_title = excluded.base_title;
    result := jsonb_set(result,'{test,base_variant_title}',to_jsonb(btrim(p_payload->>'base_variant_title')));
  end if;
  return result;
end;
$$;

revoke all on function
  public.xelay_private_test_variant_identity(public.teaching_tests,uuid,jsonb),
  public.xelay_private_test_variant_identity_guard(),
  public.xelay_private_test_view_before_variant_identity(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_view(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_attempt_view_before_variant_identity(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_mutate_before_variant_identity(text,jsonb),
  public.xelay_teaching_test_mutate(text,jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
