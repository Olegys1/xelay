-- Read-only deployment preflight for 202610030004. Returns counts, never URLs,
-- personal records or keys. Run against staging and production before rollout.
select bucket_id,count(*) as object_count,
  count(*) filter(where coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner') is null) as ownerless_objects,
  count(*) filter(where split_part(name,'/',1)!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') as legacy_paths,
  count(*) filter(where (metadata->>'size') is null or (metadata->>'size')!~'^[0-9]{1,12}$') as unknown_size_objects,
  count(*) filter(where lower(split_part(coalesce(metadata->>'mimetype',''),';',1)) not in
    ('image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime')) as legacy_other_mime
from storage.objects o where bucket_id in ('avatars','answer-media','question-images') group by bucket_id order by bucket_id;

with links as (
  select i.image_url url,q.user_id::text author from public.question_images i join public.questions q on q.id::text=i.question_id::text
  union all select i.image_url,a.user_id::text from public.answer_images i join public.answers a on a.id::text=i.answer_id::text
  union all select a.media_url,a.user_id::text from public.answers a where a.media_url is not null
), ownership as (
  select o.bucket_id,o.name,count(distinct l.author) as linked_authors
  from storage.objects o left join links l on right(l.url,length('/storage/v1/object/public/'||o.bucket_id||'/'||o.name))=
    '/storage/v1/object/public/'||o.bucket_id||'/'||o.name
  where o.bucket_id in ('answer-media','question-images')
    and coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner') is null
  group by o.bucket_id,o.name
)
select bucket_id,count(*) filter(where linked_authors=1) as recoverable_ownerless_objects,
  count(*) filter(where linked_authors=0) as unlinked_ownerless_objects,
  count(*) filter(where linked_authors>1) as ambiguous_ownerless_objects
from ownership group by bucket_id order by bucket_id;

-- Existing long texts are preserved. Only INSERTs or changed fields receive
-- the new limits; this count identifies compatibility cases for staging.
select 'questions' as content_type,count(*) filter(where length(title)>500) as long_headers,
  count(*) filter(where length(content)>50000) as long_bodies,
  count(*) filter(where length(category)>200) as long_categories from public.questions
union all
select 'answers',0,count(*) filter(where length(content)>50000),0 from public.answers;

-- These rows remain readable and are not rewritten by the migration. Before
-- enabling edits for an ambiguous ownerless file, manually verify its owner;
-- never infer ownership from a random legacy filename or repair it in bulk.
