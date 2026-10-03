-- STAGING ONLY: schema compatibility supplement, no user data or delivery hooks.
-- Order: security_staging_legacy_baseline.sql, THIS FILE, then ALL repository
-- migrations in filename order. Do not run after migrations or on production.
-- Prepend SET xelay.security_staging='true'; and submit it with this whole file.
-- The baseline resets this setting: repeat SET before this supplement when both
-- files are submitted in one SQL-editor call. This file never enables its guard.
--
-- Source: sanitized production catalog snapshot (15 legacy tables, 2026-10-03).
-- Foundation columns/defaults/NOT NULL, eight missing tables, ordinary indexes
-- and constraints are reconstructed. Repository-owned columns/foreign keys,
-- triggers and functions are installed by their migrations. No enums/views are
-- dependencies of these 15 tables. No data, secret arguments, HTTP, webhooks,
-- mail-delivery trigger or notification outbox is imported.
--
-- Security differences are intentional: translations/badges are backend-write
-- only; discussion/comment/like authors and identities cannot be forged; client
-- edits are column-scoped. Old open mutation policies are never restored.
-- Original non-HTTP legacy helper bodies are restored with fixed search_path
-- and service-only EXECUTE so migration006 also exercises its real revocations.
-- The plain database question-comment notification trigger is included. This is
-- a staging preparation file, never a production migration or schema backup.
begin;

do $$
declare v_table text; v_url text; v_has_rows boolean;
begin
  if current_setting('xelay.security_staging',true) is distinct from 'true' then
    raise exception 'STAGING ONLY: set xelay.security_staging=true explicitly';
  end if;
  v_url:=coalesce(current_setting('app.settings.supabase_url',true),'') || ' '
    || coalesce(current_setting('api.external_url',true),'');
  if v_url like '%baohfpadxvhqhhjjqtil%' then
    raise exception 'STAGING ONLY: known production project is forbidden';
  end if;
  if to_regclass('public.messages') is not null or to_regclass('public.universities') is not null
    or to_regclass('public.study_groups') is not null then
    raise exception 'STAGING ONLY: apply legacy parity BEFORE repository migrations';
  end if;
  foreach v_table in array array['profiles','questions','answers','question_images','answer_images','xelay_users','notifications'] loop
    if to_regclass('public.'||v_table) is null then
      raise exception 'STAGING ONLY: apply the empty legacy baseline first (% missing)',v_table;
    end if;
    execute format('select exists(select 1 from public.%I)',v_table) into v_has_rows;
    if v_has_rows then raise exception 'STAGING ONLY: baseline table % must be empty',v_table; end if;
  end loop;
  foreach v_table in array array['answer_discussions','answer_likes','answer_translations','badge_notifications',
    'question_comments','question_likes','question_translations','user_badges'] loop
    if to_regclass('public.'||v_table) is not null then
      raise exception 'STAGING ONLY: legacy supplement table % already exists',v_table;
    end if;
  end loop;
  if to_regclass('auth.users') is null or to_regclass('storage.objects') is null
    or to_regprocedure('auth.uid()') is null then
    raise exception 'STAGING ONLY: managed Supabase Auth and Storage are required';
  end if;
end $$;

-- Align existing foundation fields only: repo migrations own the omitted
-- username/academic profile fields and notification news/group/chat references.
alter table public.notifications alter column question_id type uuid using question_id::uuid;
alter table public.notifications alter column answer_id type uuid using answer_id::uuid;
alter table public."answer_images" alter column "id" set default gen_random_uuid(), alter column "id" set not null;
alter table public."answer_images" alter column "answer_id" drop default, alter column "answer_id" set not null;
alter table public."answer_images" alter column "image_url" drop default, alter column "image_url" set not null;
alter table public."answer_images" alter column "created_at" set default now(), alter column "created_at" drop not null;
alter table public."answer_images" alter column "media_type" drop default, alter column "media_type" drop not null;
alter table public."answers" alter column "id" set default (gen_random_uuid())::text, alter column "id" set not null;
alter table public."answers" alter column "question_id" drop default, alter column "question_id" set not null;
alter table public."answers" alter column "user_id" drop default, alter column "user_id" set not null;
alter table public."answers" alter column "content" drop default, alter column "content" set not null;
alter table public."answers" alter column "author_name" drop default, alter column "author_name" drop not null;
alter table public."answers" alter column "author_avatar" drop default, alter column "author_avatar" drop not null;
alter table public."answers" alter column "created_at" set default now(), alter column "created_at" drop not null;
alter table public."answers" alter column "likes" set default 0, alter column "likes" drop not null;
alter table public."answers" alter column "author_rating" set default 0, alter column "author_rating" drop not null;
alter table public."answers" alter column "media_url" drop default, alter column "media_url" drop not null;
alter table public."answers" alter column "media_type" drop default, alter column "media_type" drop not null;
alter table public."notifications" alter column "id" set default gen_random_uuid(), alter column "id" set not null;
alter table public."notifications" alter column "recipient_id" drop default, alter column "recipient_id" set not null;
alter table public."notifications" alter column "actor_id" drop default, alter column "actor_id" set not null;
alter table public."notifications" alter column "actor_name" drop default, alter column "actor_name" set not null;
alter table public."notifications" alter column "type" drop default, alter column "type" set not null;
alter table public."notifications" alter column "message" drop default, alter column "message" set not null;
alter table public."notifications" alter column "question_id" drop default, alter column "question_id" drop not null;
alter table public."notifications" alter column "answer_id" drop default, alter column "answer_id" drop not null;
alter table public."notifications" alter column "is_read" set default false, alter column "is_read" drop not null;
alter table public."notifications" alter column "created_at" set default now(), alter column "created_at" drop not null;
alter table public."profiles" alter column "id" drop default, alter column "id" set not null;
alter table public."profiles" alter column "full_name" drop default, alter column "full_name" drop not null;
alter table public."profiles" alter column "email" drop default, alter column "email" drop not null;
alter table public."profiles" alter column "country" drop default, alter column "country" drop not null;
alter table public."profiles" alter column "city" drop default, alter column "city" drop not null;
alter table public."profiles" alter column "experience" drop default, alter column "experience" drop not null;
alter table public."profiles" alter column "categories" drop default, alter column "categories" drop not null;
alter table public."profiles" alter column "avatar_url" drop default, alter column "avatar_url" drop not null;
alter table public."profiles" alter column "created_at" set default now(), alter column "created_at" drop not null;
alter table public."profiles" alter column "rating" set default 0, alter column "rating" drop not null;
alter table public."profiles" alter column "has_seen_onboarding" set default false, alter column "has_seen_onboarding" drop not null;
alter table public."profiles" alter column "bio" drop default, alter column "bio" drop not null;
alter table public."profiles" alter column "trust_score" set default 0, alter column "trust_score" drop not null;
alter table public."profiles" alter column "faculty" set default ''::text, alter column "faculty" set not null;
alter table public."profiles" alter column "specialty" set default ''::text, alter column "specialty" set not null;
alter table public."profiles" alter column "study_year" drop default, alter column "study_year" drop not null;
alter table public."profiles" alter column "skills" set default '{}'::text[], alter column "skills" set not null;
alter table public."profiles" alter column "help_with" set default '{}'::text[], alter column "help_with" set not null;
alter table public."profiles" alter column "want_to_learn" set default '{}'::text[], alter column "want_to_learn" set not null;
alter table public."question_images" alter column "id" set default gen_random_uuid(), alter column "id" set not null;
alter table public."question_images" alter column "question_id" drop default, alter column "question_id" set not null;
alter table public."question_images" alter column "image_url" drop default, alter column "image_url" set not null;
alter table public."question_images" alter column "created_at" set default now(), alter column "created_at" drop not null;
alter table public."questions" alter column "id" set default gen_random_uuid(), alter column "id" set not null;
alter table public."questions" alter column "user_id" drop default, alter column "user_id" set not null;
alter table public."questions" alter column "title" drop default, alter column "title" set not null;
alter table public."questions" alter column "content" drop default, alter column "content" set not null;
alter table public."questions" alter column "category" drop default, alter column "category" set not null;
alter table public."questions" alter column "author_name" drop default, alter column "author_name" drop not null;
alter table public."questions" alter column "author_avatar" drop default, alter column "author_avatar" drop not null;
alter table public."questions" alter column "created_at" set default now(), alter column "created_at" drop not null;
alter table public."questions" alter column "answers_count" set default 0, alter column "answers_count" drop not null;
alter table public."questions" alter column "is_pinned" set default false, alter column "is_pinned" drop not null;
alter table public."questions" alter column "likes" set default 0, alter column "likes" drop not null;
alter table public."questions" alter column "views" set default 0, alter column "views" drop not null;
alter table public."xelay_users" alter column "id" drop default, alter column "id" set not null;
alter table public."xelay_users" alter column "user_id" drop default, alter column "user_id" set not null;
alter table public."xelay_users" alter column "name" drop default, alter column "name" set not null;
alter table public."xelay_users" alter column "email" drop default, alter column "email" set not null;
alter table public."xelay_users" alter column "country" drop default, alter column "country" set not null;
alter table public."xelay_users" alter column "city" drop default, alter column "city" drop not null;
alter table public."xelay_users" alter column "experience" drop default, alter column "experience" set not null;
alter table public."xelay_users" alter column "categories" set default '[]'::text, alter column "categories" set not null;
alter table public."xelay_users" alter column "rating" set default 0, alter column "rating" set not null;
alter table public."xelay_users" alter column "avatar_url" set default ''::text, alter column "avatar_url" drop not null;
alter table public."xelay_users" alter column "created_at" set default now(), alter column "created_at" set not null;
alter table public.profiles add constraint profiles_email_key unique(email);
create index xelay_users_user_id_idx on public.xelay_users(user_id);

-- Eight tables absent from repository CREATE TABLE migrations.
create table public."answer_discussions" (
  "id" uuid default gen_random_uuid() not null,
  "answer_id" text not null,
  "user_id" uuid not null,
  "text" text not null,
  "created_at" timestamp with time zone default now(),
  constraint "answer_discussions_answer_id_fkey" FOREIGN KEY (answer_id) REFERENCES answers(id) ON DELETE CASCADE,
  constraint "answer_discussions_pkey" PRIMARY KEY (id),
  constraint "answer_discussions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
alter table public."answer_discussions" enable row level security;
create table public."answer_likes" (
  "id" uuid default gen_random_uuid() not null,
  "answer_id" text not null,
  "user_id" text not null,
  "created_at" timestamp with time zone default now(),
  constraint "answer_likes_pkey" PRIMARY KEY (id)
);
CREATE UNIQUE INDEX answer_likes_unique ON public.answer_likes USING btree (answer_id, user_id);
alter table public."answer_likes" enable row level security;
create table public."answer_translations" (
  "id" uuid default gen_random_uuid() not null,
  "answer_id" text not null,
  "language" text not null,
  "translated_text" text not null,
  "created_at" timestamp with time zone default now(),
  constraint "answer_translations_answer_id_fkey" FOREIGN KEY (answer_id) REFERENCES answers(id) ON DELETE CASCADE,
  constraint "answer_translations_answer_id_language_key" UNIQUE (answer_id, language),
  constraint "answer_translations_pkey" PRIMARY KEY (id)
);
alter table public."answer_translations" enable row level security;
create table public."badge_notifications" (
  "id" uuid default gen_random_uuid() not null,
  "user_id" text not null,
  "badge_type" text not null,
  "is_seen" boolean default false,
  "created_at" timestamp with time zone default now(),
  constraint "badge_notifications_pkey" PRIMARY KEY (id)
);
alter table public."badge_notifications" enable row level security;
create table public."question_comments" (
  "id" uuid default gen_random_uuid() not null,
  "question_id" text not null,
  "user_id" uuid not null,
  "body" text not null,
  "created_at" timestamp with time zone default now() not null,
  constraint "question_comments_body_check" CHECK (length(btrim(body)) >= 1 AND length(btrim(body)) <= 3000),
  constraint "question_comments_pkey" PRIMARY KEY (id),
  constraint "question_comments_question_id_fkey" FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
  constraint "question_comments_user_id_fkey" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX question_comments_question_created_idx ON public.question_comments USING btree (question_id, created_at);
alter table public."question_comments" enable row level security;
create table public."question_likes" (
  "id" uuid default gen_random_uuid() not null,
  "question_id" text not null,
  "user_id" uuid not null,
  "created_at" timestamp with time zone default now(),
  constraint "question_likes_pkey" PRIMARY KEY (id),
  constraint "question_likes_question_id_fkey" FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
  constraint "question_likes_question_id_user_id_key" UNIQUE (question_id, user_id)
);
alter table public."question_likes" enable row level security;
create table public."question_translations" (
  "id" uuid default gen_random_uuid() not null,
  "question_id" text not null,
  "language" text not null,
  "translated_text" text not null,
  "created_at" timestamp with time zone default now(),
  constraint "question_translations_pkey" PRIMARY KEY (id),
  constraint "question_translations_question_id_fkey" FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
  constraint "question_translations_question_id_language_key" UNIQUE (question_id, language)
);
alter table public."question_translations" enable row level security;
create table public."user_badges" (
  "id" uuid default gen_random_uuid() not null,
  "user_id" text not null,
  "badge_type" text not null,
  "earned_at" timestamp with time zone default now(),
  constraint "user_badges_pkey" PRIMARY KEY (id)
);
CREATE UNIQUE INDEX user_badges_unique ON public.user_badges USING btree (user_id, badge_type);
alter table public."user_badges" enable row level security;

-- Explicit permissions: the new project does not grant new public tables by default.
revoke all on public.answer_discussions,public.answer_likes,public.answer_translations,
  public.badge_notifications,public.question_comments,public.question_likes,
  public.question_translations,public.user_badges from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.profiles,public.questions,public.answers,
  public.question_images,public.answer_images,public.xelay_users,public.notifications,
  public.answer_discussions,public.answer_likes,public.answer_translations,
  public.badge_notifications,public.question_comments,public.question_likes,
  public.question_translations,public.user_badges to service_role;
grant select on public.answer_discussions,public.answer_translations,public.question_comments,
  public.question_likes,public.question_translations,public.user_badges to anon,authenticated;
grant select on public.answer_likes,public.badge_notifications to authenticated;
grant insert(answer_id,user_id,text),update(text) on public.answer_discussions to authenticated;
grant delete on public.answer_discussions to authenticated;
grant insert(question_id,user_id,body) on public.question_comments to authenticated;
grant delete on public.question_comments to authenticated;
grant insert(answer_id,user_id) on public.answer_likes to authenticated;
grant delete on public.answer_likes to authenticated;
grant insert(question_id,user_id) on public.question_likes to authenticated;
grant delete on public.question_likes to authenticated;
grant update(is_seen) on public.badge_notifications to authenticated;

create policy "Staging discussion public read" on public.answer_discussions for select to anon,authenticated
  using(exists(select 1 from public.answers a where a.id=answer_id));
create policy "Staging discussion own insert" on public.answer_discussions for insert to authenticated
  with check(user_id=auth.uid() and exists(select 1 from public.answers a where a.id=answer_id));
create policy "Staging discussion own edit" on public.answer_discussions for update to authenticated
  using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy "Staging discussion own delete" on public.answer_discussions for delete to authenticated using(user_id=auth.uid());
create policy "Staging question comment visible read" on public.question_comments for select to anon,authenticated
  using(exists(select 1 from public.questions q where q.id=question_id));
create policy "Staging question comment own insert" on public.question_comments for insert to authenticated
  with check(user_id=auth.uid() and exists(select 1 from public.questions q where q.id=question_id));
create policy "Staging question comment own delete" on public.question_comments for delete to authenticated using(user_id=auth.uid());
create policy "Staging answer likes visible read" on public.answer_likes for select to authenticated
  using(exists(select 1 from public.answers a where a.id=answer_id));
create policy "Staging answer likes own insert" on public.answer_likes for insert to authenticated
  with check(user_id=auth.uid()::text and exists(select 1 from public.answers a where a.id=answer_id));
create policy "Staging answer likes own delete" on public.answer_likes for delete to authenticated using(user_id=auth.uid()::text);
create policy "Staging question likes visible read" on public.question_likes for select to anon,authenticated
  using(exists(select 1 from public.questions q where q.id=question_id));
create policy "Staging question likes own insert" on public.question_likes for insert to authenticated
  with check(user_id=auth.uid() and exists(select 1 from public.questions q where q.id=question_id));
create policy "Staging question likes own delete" on public.question_likes for delete to authenticated using(user_id=auth.uid());
create policy "Staging answer translations read" on public.answer_translations for select to anon,authenticated
  using(exists(select 1 from public.answers a where a.id=answer_id));
create policy "Staging question translations read" on public.question_translations for select to anon,authenticated
  using(exists(select 1 from public.questions q where q.id=question_id));
create policy "Staging badges public read" on public.user_badges for select to anon,authenticated using(true);
create policy "Staging badge notification own read" on public.badge_notifications for select to authenticated using(user_id=auth.uid()::text);
create policy "Staging badge notification own acknowledge" on public.badge_notifications for update to authenticated
  using(user_id=auth.uid()::text) with check(user_id=auth.uid()::text);

-- Legacy ordinary SQL helpers, with safe ACLs before any historical migration.
CREATE OR REPLACE FUNCTION public.award_pioneer_badge(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_profiles_count integer;
begin

  select count(*)
  into v_profiles_count
  from profiles;

  if v_profiles_count <= 100 then

    insert into user_badges (
      user_id,
      badge_type
    )
    values (
      p_user_id,
      'pioneer'
    )
    on conflict do nothing;

  end if;

end;
$function$;
alter function public.award_pioneer_badge(uuid) set search_path to public,pg_temp;
revoke all on function public.award_pioneer_badge(uuid) from public,anon,authenticated,service_role;
grant execute on function public.award_pioneer_badge(uuid) to service_role;
CREATE OR REPLACE FUNCTION public.check_expert_badge(profile_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$declare
  answers_count integer;
begin

  select count(*)
  into answers_count
  from answers
  where user_id = profile_id;

  if answers_count >= 25 then

    insert into user_badges(
      user_id,
      badge_type
    )
    select
      profile_id,
      'expert'
    where not exists (
      select 1
      from user_badges
      where user_id = profile_id
      and badge_type = 'expert'
    );

  end if;

end;$function$;
alter function public.check_expert_badge(text) set search_path to public,pg_temp;
revoke all on function public.check_expert_badge(text) from public,anon,authenticated,service_role;
grant execute on function public.check_expert_badge(text) to service_role;
CREATE OR REPLACE FUNCTION public.check_user_badges(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$declare
  v_answers_count integer;
  v_rating integer;
  v_total_likes integer;
begin

  select count(*)
  into v_answers_count
  from answers
  where user_id = p_user_id::text;

  select coalesce(rating, 0)
  into v_rating
  from profiles
  where id = p_user_id;

  select coalesce(sum(likes), 0)
  into v_total_likes
  from answers
  where user_id = p_user_id::text;

  if v_answers_count >= 20
  and v_rating >= 20 then

    insert into user_badges (
      user_id,
      badge_type
    )
    values (
      p_user_id::text,
      'expert'
    )
    on conflict do nothing;

  end if;

  if v_answers_count >= 100
  and v_rating >= 100 then

    insert into user_badges (
      user_id,
      badge_type
    )
    values (
      p_user_id::text,
      'authority'
    )
    on conflict do nothing;

  end if;

  if v_total_likes >= 50 then

    insert into user_badges (
      user_id,
      badge_type
    )
    values (
      p_user_id::text,
      'community_favorite'
    )
    on conflict do nothing;

  end if;

end;$function$;
alter function public.check_user_badges(uuid) set search_path to public,pg_temp;
revoke all on function public.check_user_badges(uuid) from public,anon,authenticated,service_role;
grant execute on function public.check_user_badges(uuid) to service_role;
CREATE OR REPLACE FUNCTION public.increment_profile_rating(profile_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  update profiles
  set rating = coalesce(rating, 0) + 1
  where id = profile_id;
$function$;
alter function public.increment_profile_rating(uuid) set search_path to public,pg_temp;
revoke all on function public.increment_profile_rating(uuid) from public,anon,authenticated,service_role;
grant execute on function public.increment_profile_rating(uuid) to service_role;
CREATE OR REPLACE FUNCTION public.increment_question_views(question_id text)
 RETURNS void
 LANGUAGE sql
AS $function$
UPDATE questions
SET views = COALESCE(views, 0) + 1
WHERE id = question_id;
$function$;
alter function public.increment_question_views(text) set search_path to public,pg_temp;
revoke all on function public.increment_question_views(text) from public,anon,authenticated,service_role;
grant execute on function public.increment_question_views(text) to service_role;
CREATE OR REPLACE FUNCTION public.xelay_notify_question_comment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;
alter function public.xelay_notify_question_comment() set search_path to public,pg_temp;
revoke all on function public.xelay_notify_question_comment() from public,anon,authenticated,service_role;
create trigger question_comment_notification after insert on public.question_comments
  for each row execute function public.xelay_notify_question_comment();

-- The remaining ordinary legacy triggers are repository-owned. In particular,
-- 202609300004 creates parent locks, answer recount and deletion cleanup after
-- it can see all eight tables; 202610010004 installs the answer DB notification.
commit;
reset xelay.security_staging;
