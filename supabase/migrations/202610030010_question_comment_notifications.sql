-- Preserve ordinary legacy comments with the real UUID notification references.
-- Existing question IDs are text and may predate the UUID-string convention.
-- This replaces a pre-existing text-to-UUID INSERT bug, not a security guard.
begin;

create or replace function public.xelay_notify_question_comment()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_actor_name text;
  v_question_reference uuid;
begin
  -- Resolve the recipient through a real profile instead of casting a legacy
  -- question.user_id string. Missing/deleted profile recipients are skipped.
  select p.id into v_owner_id
    from public.questions q join public.profiles p on p.id::text=q.user_id::text
    where q.id::text=new.question_id::text;
  if v_owner_id is null or v_owner_id=new.user_id then return new; end if;

  select p.full_name into v_actor_name from public.profiles p where p.id=new.user_id;
  begin
    v_question_reference:=new.question_id::uuid;
  exception when invalid_text_representation then
    -- Preserve the comment and its notification for non-UUID historical IDs.
    -- The optional UUID link is absent; no fabricated reference is introduced.
    v_question_reference:=null;
  end;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,question_id)
    values(v_owner_id,new.user_id,coalesce(nullif(v_actor_name,''),'Учасник'),
      'question_comment','прокоментував(-ла) ваше запитання',false,v_question_reference);
  return new;
end;
$$;
revoke all on function public.xelay_notify_question_comment() from public,anon,authenticated,service_role;

-- Minimal legacy bootstraps may omit this table. Production and the schema
-- parity bootstrap have it; install exactly one internal notification trigger.
do $$
begin
  if to_regclass('public.question_comments') is not null then
    execute 'drop trigger if exists question_comment_notification on public.question_comments';
    execute 'create trigger question_comment_notification after insert on public.question_comments
      for each row execute function public.xelay_notify_question_comment()';
  end if;
end;
$$;

commit;
