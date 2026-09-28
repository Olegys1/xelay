-- Comments attached directly to community questions.

create table if not exists public.question_comments (
  id uuid primary key default gen_random_uuid(),
  question_id text not null references public.questions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 3000),
  created_at timestamptz not null default now()
);

create index if not exists question_comments_question_created_idx
  on public.question_comments (question_id, created_at);

alter table public.question_comments enable row level security;

drop policy if exists "Question comments are visible with their question" on public.question_comments;
create policy "Question comments are visible with their question"
  on public.question_comments for select to anon, authenticated
  using (exists (select 1 from public.questions q where q.id = question_comments.question_id));

drop policy if exists "Authenticated users can comment on visible questions" on public.question_comments;
create policy "Authenticated users can comment on visible questions"
  on public.question_comments for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.questions q where q.id = question_comments.question_id)
  );

drop policy if exists "Authors can remove their own question comments" on public.question_comments;
create policy "Authors can remove their own question comments"
  on public.question_comments for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.question_comments from public, anon, authenticated;
grant select on public.question_comments to anon, authenticated;
grant insert, delete on public.question_comments to authenticated;

create or replace function public.xelay_notify_question_comment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_actor_name text;
begin
  select user_id into v_owner_id from public.questions where id = new.question_id;
  if v_owner_id is not null and v_owner_id <> new.user_id then
    select full_name into v_actor_name from public.profiles where id = new.user_id;
    insert into public.notifications (recipient_id, actor_id, actor_name, type, message, is_read, question_id)
    values (v_owner_id, new.user_id, coalesce(nullif(v_actor_name, ''), 'Учасник'),
      'question_comment', 'прокоментував(-ла) ваше запитання', false, new.question_id);
  end if;
  return new;
end;
$$;

drop trigger if exists question_comment_notification on public.question_comments;
create trigger question_comment_notification
  after insert on public.question_comments
  for each row execute function public.xelay_notify_question_comment();

revoke all on function public.xelay_notify_question_comment() from public, anon, authenticated;
