-- Delete one's own questions and answers without assuming legacy FK actions
-- or changing the existing TEXT/UUID identifier types.
begin;

do $$
declare
  v_required record;
  v_relation regclass;
begin
  for v_required in
    select * from (values
      ('questions', 'id'), ('questions', 'user_id'), ('questions', 'answers_count'),
      ('answers', 'id'), ('answers', 'user_id'), ('answers', 'question_id')
    ) as required(table_name, column_name)
  loop
    v_relation := to_regclass(format('public.%I', v_required.table_name));
    if v_relation is null or not exists (
      select 1 from pg_attribute
      where attrelid = v_relation and attname = v_required.column_name
        and attnum > 0 and not attisdropped
    ) then
      raise exception 'Required community column public.%.% is missing',
        v_required.table_name, v_required.column_name;
    end if;
  end loop;
end;
$$;

-- Serialize setup with writes while installing the triggers and reconciling
-- historical counters. The primary legacy tables and their IDs stay intact.
lock table public.questions, public.answers in share row exclusive mode;

create or replace function public.xelay_cleanup_community_reference(
  p_table text, p_column text, p_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_relation regclass;
begin
  if p_table is null or p_column is null or (p_table, p_column) not in (
    ('question_images', 'question_id'), ('answer_images', 'answer_id'),
    ('answer_discussions', 'answer_id'), ('question_comments', 'question_id'),
    ('question_comments', 'answer_id'), ('notifications', 'question_id'),
    ('notifications', 'answer_id')
  ) then
    raise exception 'Unsupported community dependency';
  end if;
  v_relation := to_regclass(format('public.%I', p_table));
  if v_relation is null or not exists (
    select 1 from pg_attribute
    where attrelid = v_relation and attname = p_column
      and attnum > 0 and not attisdropped
  ) then
    return;
  end if;
  execute format('delete from public.%I where %I::text = $1', p_table, p_column)
    using p_id;
end;
$$;

create or replace function public.xelay_cleanup_deleted_answer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.xelay_cleanup_community_reference('notifications', 'answer_id', old.id::text);
  perform public.xelay_cleanup_community_reference('question_comments', 'answer_id', old.id::text);
  perform public.xelay_cleanup_community_reference('answer_discussions', 'answer_id', old.id::text);
  perform public.xelay_cleanup_community_reference('answer_images', 'answer_id', old.id::text);
  return old;
end;
$$;

create or replace function public.xelay_cleanup_deleted_question()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.xelay_cleanup_community_reference('notifications', 'question_id', old.id::text);
  perform public.xelay_cleanup_community_reference('question_comments', 'question_id', old.id::text);
  perform public.xelay_cleanup_community_reference('question_images', 'question_id', old.id::text);
  delete from public.answers where question_id::text = old.id::text;
  return old;
end;
$$;

drop trigger if exists xelay_cleanup_deleted_answer on public.answers;
create trigger xelay_cleanup_deleted_answer
  before delete on public.answers
  for each row execute function public.xelay_cleanup_deleted_answer();

drop trigger if exists xelay_cleanup_deleted_question on public.questions;
create trigger xelay_cleanup_deleted_question
  before delete on public.questions
  for each row execute function public.xelay_cleanup_deleted_question();

-- New answers acquire the parent lock before insertion, matching the delete
-- RPCs. This also prevents a new orphan if the legacy schema lacks an FK.
create or replace function public.xelay_lock_answer_question()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform 1 from public.questions
  where id::text = new.question_id::text for update;
  if not found then raise exception 'Question not found' using errcode = '23503'; end if;
  return new;
end;
$$;

drop trigger if exists xelay_lock_answer_question on public.answers;
create trigger xelay_lock_answer_question
  before insert on public.answers
  for each row execute function public.xelay_lock_answer_question();

-- Children hold parent locks until commit. Inserts concurrent with deletion
-- either finish before cleanup or fail after deletion, even without legacy FKs.
create or replace function public.xelay_lock_community_dependency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_question_id text;
  v_answer_id text;
  v_answer_question_id text;
  v_locked_question_id text;
begin
  if tg_table_schema <> 'public' or tg_nargs <> 2 or tg_table_name not in (
    'question_images', 'answer_images', 'answer_discussions', 'question_comments', 'notifications'
  ) then
    raise exception 'Unsupported community dependency';
  end if;
  if (tg_argv[0] <> '' and (tg_table_name, tg_argv[0]) not in (
    ('question_images', 'question_id'), ('question_comments', 'question_id'), ('notifications', 'question_id')
  )) or (tg_argv[1] <> '' and (tg_table_name, tg_argv[1]) not in (
    ('answer_images', 'answer_id'), ('answer_discussions', 'answer_id'),
    ('question_comments', 'answer_id'), ('notifications', 'answer_id')
  )) then
    raise exception 'Unsupported community dependency column';
  end if;

  v_row := to_jsonb(new);
  v_question_id := case when tg_argv[0] <> '' then v_row ->> tg_argv[0] end;
  v_answer_id := case when tg_argv[1] <> '' then v_row ->> tg_argv[1] end;
  -- Other notification types have no community reference.
  if v_question_id is null and v_answer_id is null then
    if tg_table_name = 'notifications' then return new; end if;
    raise exception 'Community parent reference required' using errcode = '23502';
  end if;

  if v_answer_id is not null then
    select question_id::text into v_answer_question_id
    from public.answers where id::text = v_answer_id;
    if not found or v_answer_question_id is null then
      raise exception 'Answer not found' using errcode = '23503';
    end if;
    if v_question_id is not null and v_question_id is distinct from v_answer_question_id then
      raise exception 'Answer does not belong to question' using errcode = '23503';
    end if;
    v_question_id := v_answer_question_id;
  end if;

  -- Question first, answer second: the deletion RPCs use the same order.
  perform 1 from public.questions where id::text = v_question_id for key share;
  if not found then raise exception 'Question not found' using errcode = '23503'; end if;
  if v_answer_id is not null then
    -- SHARE also prevents a non-key UPDATE from moving the answer to another
    -- question while this transaction is creating its child record.
    select question_id::text into v_locked_question_id
    from public.answers where id::text = v_answer_id for share;
    if not found then raise exception 'Answer not found' using errcode = '23503'; end if;
    if v_locked_question_id is distinct from v_question_id then
      raise exception 'Answer changed while adding its dependency; retry' using errcode = '40001';
    end if;
  end if;
  return new;
end;
$$;

-- Install only for known tables and columns present in the legacy schema.
do $$
declare
  v_dependency record;
  v_relation regclass;
  v_question_column text;
  v_answer_column text;
  v_columns text;
begin
  for v_dependency in
    select * from (values
      ('question_images', 'question_id', null::text),
      ('answer_images', null::text, 'answer_id'),
      ('answer_discussions', null::text, 'answer_id'),
      ('question_comments', 'question_id', 'answer_id'),
      ('notifications', 'question_id', 'answer_id')
    ) as dependency(table_name, question_column, answer_column)
  loop
    v_relation := to_regclass(format('public.%I', v_dependency.table_name));
    if v_relation is null then continue; end if;
    v_question_column := null;
    v_answer_column := null;
    if v_dependency.question_column is not null and exists (
      select 1 from pg_attribute where attrelid = v_relation
        and attname = v_dependency.question_column and attnum > 0 and not attisdropped
    ) then v_question_column := v_dependency.question_column; end if;
    if v_dependency.answer_column is not null and exists (
      select 1 from pg_attribute where attrelid = v_relation
        and attname = v_dependency.answer_column and attnum > 0 and not attisdropped
    ) then v_answer_column := v_dependency.answer_column; end if;
    execute format('drop trigger if exists xelay_lock_community_dependency on public.%I', v_dependency.table_name);
    if v_question_column is null and v_answer_column is null then continue; end if;
    v_columns := concat_ws(', ',
      case when v_question_column is not null then format('%I', v_question_column) end,
      case when v_answer_column is not null then format('%I', v_answer_column) end
    );
    execute format(
      'create trigger xelay_lock_community_dependency before insert or update of %s on public.%I for each row execute function public.xelay_lock_community_dependency(%L, %L)',
      v_columns, v_dependency.table_name, coalesce(v_question_column, ''), coalesce(v_answer_column, '')
    );
  end loop;
end;
$$;

-- Old browser tabs used to write a cached counter after inserting an answer.
-- Ignore that requested value and retain the actual count on every such update.
create or replace function public.xelay_guard_question_answers_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select count(*) into new.answers_count from public.answers
  where question_id::text = new.id::text;
  return new;
end;
$$;

drop trigger if exists xelay_guard_question_answers_count on public.questions;
create trigger xelay_guard_question_answers_count
  before update of answers_count on public.questions
  for each row execute function public.xelay_guard_question_answers_count();

create or replace function public.xelay_recount_question_answers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_question_id text;
begin
  v_question_id := case when tg_op = 'DELETE' then old.question_id::text else new.question_id::text end;
  perform 1 from public.questions where id::text = v_question_id for update;
  if found then
    update public.questions q
    set answers_count = (
      select count(*) from public.answers a where a.question_id::text = v_question_id
    )
    where q.id::text = v_question_id;
  end if;
  return null;
end;
$$;

-- Run after ordinary legacy answer triggers and after an enclosing question
-- deletion. A removed question is skipped rather than modified mid-delete.
drop trigger if exists xelay_recount_question_answers on public.answers;
create constraint trigger xelay_recount_question_answers
  after insert or delete on public.answers
  deferrable initially deferred
  for each row execute function public.xelay_recount_question_answers();

create or replace function public.xelay_delete_own_question(p_question_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select user_id::text into v_owner_id from public.questions
  where id::text = p_question_id for update;
  if not found then raise exception 'Question not found' using errcode = 'P0002'; end if;
  if v_owner_id is distinct from auth.uid()::text then
    raise exception 'Author permission required' using errcode = '42501';
  end if;
  -- Delete children before starting the parent's DELETE. Legacy answer
  -- triggers may update the parent's counter; doing that from the parent's
  -- BEFORE DELETE trigger would try to modify a row already being deleted.
  delete from public.answers where question_id::text = p_question_id;
  delete from public.questions where id::text = p_question_id;
end;
$$;

create or replace function public.xelay_delete_own_answer(p_answer_id text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id text;
  v_question_id text;
  v_locked_question_id text;
  v_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select user_id::text, question_id::text into v_owner_id, v_question_id
  from public.answers where id::text = p_answer_id;
  if not found then raise exception 'Answer not found' using errcode = 'P0002'; end if;
  if v_owner_id is distinct from auth.uid()::text then
    raise exception 'Author permission required' using errcode = '42501';
  end if;

  -- Parent first, then child: question deletion uses this same order.
  perform 1 from public.questions where id::text = v_question_id for update;
  select user_id::text, question_id::text into v_owner_id, v_locked_question_id
  from public.answers where id::text = p_answer_id for update;
  if not found then raise exception 'Answer not found' using errcode = 'P0002'; end if;
  if v_owner_id is distinct from auth.uid()::text then
    raise exception 'Author permission required' using errcode = '42501';
  end if;
  if v_locked_question_id is distinct from v_question_id then
    raise exception 'Answer changed while being deleted; retry' using errcode = '40001';
  end if;

  delete from public.answers where id::text = p_answer_id;
  update public.questions q
  set answers_count = (
    select count(*) from public.answers a where a.question_id::text = v_question_id
  )
  where q.id::text = v_question_id
  returning q.answers_count::integer into v_count;
  return coalesce(v_count, 0);
end;
$$;

-- Require the owner-checked entry points for application users. Cleanup
-- triggers still cover privileged dashboard/service-role deletions.
revoke delete on public.questions, public.answers from public, anon, authenticated;
revoke all on function public.xelay_cleanup_community_reference(text, text, text) from public, anon, authenticated;
revoke all on function public.xelay_cleanup_deleted_answer() from public, anon, authenticated;
revoke all on function public.xelay_cleanup_deleted_question() from public, anon, authenticated;
revoke all on function public.xelay_lock_answer_question() from public, anon, authenticated;
revoke all on function public.xelay_lock_community_dependency() from public, anon, authenticated;
revoke all on function public.xelay_guard_question_answers_count() from public, anon, authenticated;
revoke all on function public.xelay_recount_question_answers() from public, anon, authenticated;
revoke all on function public.xelay_delete_own_question(text) from public, anon, authenticated;
revoke all on function public.xelay_delete_own_answer(text) from public, anon, authenticated;
grant execute on function public.xelay_delete_own_question(text) to authenticated;
grant execute on function public.xelay_delete_own_answer(text) to authenticated;

update public.questions q
set answers_count = (
  select count(*) from public.answers a where a.question_id::text = q.id::text
);

commit;
