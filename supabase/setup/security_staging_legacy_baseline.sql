-- STAGING ONLY. Never run this file on production or an existing Xelay database.
-- In the SQL editor of a NEW, EMPTY Supabase project, prepend this explicit
-- operator statement and execute it together with this whole file in ONE call:
--   SET xelay.security_staging = 'true';
-- Then apply ALL repository migrations in filename order. Session settings may
-- not survive separate SQL-editor calls, so do not submit SET in a separate call.
-- The confirmation must be set separately; this file never enables it itself.
-- Known production reference baohfpadxvhqhhjjqtil is refused when URL settings
-- expose it. Existing baseline tables (especially profiles) are always refused.
--
-- Reconstructed from the seven legacy column metadata records in
-- scripts/security/legacy-fixture.json, excluding messages (migration-owned),
-- plus the notification columns required by repository migrations. No user data.
-- Four profile columns added by repository migrations are intentionally omitted:
-- username, university_id, academic_unit_id, specialty_id. This lets those
-- migrations create their original constraints/indexes rather than skip ADDs.
--
-- This is a MINIMAL staging bootstrap, not an exact historical schema restore.
-- Legacy NOT NULL declarations, unrelated tables/functions/triggers/extensions,
-- historic indexes and platform settings are not reconstructed from columns.
-- A reviewed schema-only export of the real baseline is preferred for parity.
-- Known omitted legacy tables: answer_discussions, answer_likes,
-- answer_translations, badge_notifications, question_comments, question_likes,
-- question_translations, user_badges. Likes/comments/translations/badges are
-- outside this minimal bootstrap until a reviewed schema-only export adds them.
-- Auth, Storage, roles, and platform functions must already be managed by
-- Supabase; this file creates no substitute auth/storage schemas or objects.
-- No legacy open mutation policy or score-increment RPC is imported.
begin;

do $$
declare v_name text; v_url text;
begin
  if current_setting('xelay.security_staging',true) is distinct from 'true' then
    raise exception 'STAGING ONLY: set xelay.security_staging=true explicitly in a new empty Supabase project';
  end if;
  v_url:=coalesce(current_setting('app.settings.supabase_url',true),'') || ' '
    || coalesce(current_setting('api.external_url',true),'');
  if v_url like '%baohfpadxvhqhhjjqtil%' then
    raise exception 'STAGING ONLY: known production project is forbidden';
  end if;
  foreach v_name in array array['profiles','questions','answers','question_images','answer_images','xelay_users','notifications','messages'] loop
    if to_regclass('public.' || v_name) is not null then
      raise exception 'STAGING ONLY: public.% already exists; use a new empty project',v_name;
    end if;
  end loop;
  if to_regclass('auth.users') is null or to_regclass('storage.objects') is null
    or to_regclass('storage.buckets') is null or to_regprocedure('auth.uid()') is null then
    raise exception 'STAGING ONLY: real managed Supabase Auth and Storage are required';
  end if;
end $$;

create table public.profiles (
  id uuid primary key,
  full_name text,
  email text,
  country text,
  city text,
  experience text,
  categories text[],
  avatar_url text,
  created_at timestamptz default now(),
  rating integer default 0,
  has_seen_onboarding boolean default false,
  bio text,
  trust_score integer default 0,
  faculty text default '',
  specialty text default '',
  study_year smallint,
  skills text[] default '{}',
  help_with text[] default '{}',
  want_to_learn text[] default '{}'
);
create table public.questions (
  id text primary key default gen_random_uuid(),
  user_id text,
  title text,
  content text,
  category text,
  author_name text,
  author_avatar text,
  created_at timestamptz default now(),
  answers_count integer default 0,
  is_pinned boolean default false,
  likes integer default 0,
  views bigint default 0
);
create table public.answers (
  id text primary key default gen_random_uuid()::text,
  question_id text,
  user_id text,
  content text,
  author_name text,
  author_avatar text,
  created_at timestamptz default now(),
  likes integer default 0,
  author_rating integer default 0,
  media_url text,
  media_type text
);
create table public.question_images (
  id uuid primary key default gen_random_uuid(),
  question_id text,
  image_url text,
  created_at timestamptz default now()
);
create table public.answer_images (
  id uuid primary key default gen_random_uuid(),
  answer_id text,
  image_url text,
  created_at timestamptz default now(),
  media_type text
);
create table public.xelay_users (
  id text primary key,
  user_id text,
  name text,
  email text,
  country text,
  city text,
  experience text,
  categories text default '[]',
  rating integer default 0,
  avatar_url text default '',
  created_at timestamptz default now()
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid,
  actor_id uuid,
  actor_name text,
  type text,
  message text,
  is_read boolean default false,
  question_id text,
  answer_id text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;
alter table public.questions enable row level security;
alter table public.answers enable row level security;
alter table public.question_images enable row level security;
alter table public.answer_images enable row level security;
alter table public.xelay_users enable row level security;
alter table public.notifications enable row level security;
revoke all on public.profiles,public.questions,public.answers,public.question_images,
  public.answer_images,public.xelay_users,public.notifications from public,anon,authenticated,service_role;
grant usage on schema public to anon,authenticated,service_role;
grant select,insert,update on public.profiles to authenticated;
grant select on public.questions,public.answers,public.question_images,public.answer_images to anon,authenticated;
-- Backend mail reads receive an explicit grant again in the notification migration.
-- No blanket/default grant is needed for tables created by subsequent migrations.
create policy "Staging own profile read" on public.profiles for select to authenticated using(id=auth.uid());
create policy "Staging own profile insert" on public.profiles for insert to authenticated with check(id=auth.uid());
create policy "Staging own profile update" on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create policy "Staging public questions" on public.questions for select to anon,authenticated using(true);
create policy "Staging public answers" on public.answers for select to anon,authenticated using(true);
create policy "Staging public question images" on public.question_images for select to anon,authenticated using(true);
create policy "Staging public answer images" on public.answer_images for select to anon,authenticated using(true);

-- Real managed bucket rows/policies, not Storage schema stubs. Later migration004
-- adds reservations, byte/rate quotas, attachment ownership and MIME boundaries.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
  ('avatars','avatars',true,5242880,array['image/jpeg','image/png','image/webp','image/gif','image/avif']),
  ('answer-media','answer-media',true,26214400,array['image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime']),
  ('question-images','question-images',true,26214400,array['image/jpeg','image/png','image/webp','image/gif','image/avif'])
on conflict(id) do nothing;
create policy "Staging public media metadata" on storage.objects for select to anon,authenticated
  using(bucket_id in('avatars','answer-media','question-images'));
create policy "Staging upload own public media" on storage.objects for insert to authenticated
  with check(bucket_id in('avatars','answer-media','question-images')
    and split_part(name,'/',1)=auth.uid()::text and name !~ '(^|/)\.\.?(/|$)' and length(name)<=512
    and coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')=auth.uid()::text);
create policy "Staging update own avatar" on storage.objects for update to authenticated
  using(bucket_id='avatars' and coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')=auth.uid()::text)
  with check(bucket_id='avatars' and coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')=auth.uid()::text);
create policy "Staging remove own public media" on storage.objects for delete to authenticated
  using(bucket_id in('avatars','answer-media','question-images')
    and coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')=auth.uid()::text);

commit;
reset xelay.security_staging;
