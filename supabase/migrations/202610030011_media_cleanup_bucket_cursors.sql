-- Managed Storage cannot guarantee permission to create custom indexes. Scan
-- bounded, ordered name pages through its existing (bucket_id,name) index.
-- Candidate/reference/age filters are evaluated only after each bounded page.
begin;

create table public.media_cleanup_bucket_cursors (
  bucket_id text primary key check(bucket_id in('avatars','answer-media','question-images','xelay-message-media','xelay-chat-media')),
  last_storage_path text not null default '',
  updated_at timestamptz not null default now()
);
create table public.media_cleanup_bucket_rotation (
  scope text primary key check(scope in('public','private')),
  next_bucket integer not null default 0 check(next_bucket>=0 and
    ((scope='public' and next_bucket<3) or (scope='private' and next_bucket<2))),
  updated_at timestamptz not null default now()
);
alter table public.media_cleanup_bucket_cursors enable row level security;
alter table public.media_cleanup_bucket_rotation enable row level security;
revoke all on public.media_cleanup_bucket_cursors,public.media_cleanup_bucket_rotation from public,anon,authenticated,service_role;
insert into public.media_cleanup_bucket_cursors(bucket_id) values
  ('avatars'),('answer-media'),('question-images'),('xelay-message-media'),('xelay-chat-media');
insert into public.media_cleanup_bucket_rotation(scope) values('public'),('private');

create or replace function public.xelay_media_cleanup_scan_candidates(p_scope text,p_before timestamptz,p_limit integer)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_buckets text[];
  v_start integer;
  v_count integer;
  v_per_bucket integer;
  v_offset integer;
  v_bucket text;
  v_last text;
  v_seen integer;
  v_result jsonb:='[]';
  v_object record;
begin
  if p_scope not in('public','private') or p_scope is null or p_before is null
    or not isfinite(p_before) or p_before>clock_timestamp()-interval '1 hour'
    or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid cleanup window' using errcode='22023';
  end if;
  v_buckets:=case when p_scope='public' then array['avatars','answer-media','question-images']
    else array['xelay-message-media','xelay-chat-media'] end;
  v_count:=cardinality(v_buckets);
  -- At most 198 public / 200 private Storage rows are inspected per RPC.
  -- Even p_limit=1 gives every bucket a one-row page unless a result ends the
  -- call early. Rotating the first bucket prevents that early exit starvation.
  v_per_bucket:=greatest(1,least(200,p_limit*2)/v_count);
  select next_bucket into v_start from public.media_cleanup_bucket_rotation
    where scope=p_scope for update;
  if not found then raise exception 'Cleanup cursor missing'; end if;
  update public.media_cleanup_bucket_rotation set next_bucket=(v_start+1)%v_count,
    updated_at=clock_timestamp() where scope=p_scope;

  for v_offset in 0..v_count-1 loop
    v_bucket:=v_buckets[1+(v_start+v_offset)%v_count];
    select last_storage_path into v_last from public.media_cleanup_bucket_cursors
      where bucket_id=v_bucket for update;
    if not found then raise exception 'Cleanup bucket cursor missing'; end if;
    v_seen:=0;
    -- No age, owner, reference or claim filter belongs in this query: they
    -- would allow PostgreSQL to inspect an unbounded retained/fresh prefix.
    for v_object in select o.* from storage.objects o
      where o.bucket_id=v_bucket and o.name>v_last
      order by o.name limit v_per_bucket
    loop
      v_seen:=v_seen+1;
      v_last:=v_object.name;
      if v_object.created_at<p_before and coalesce(v_object.updated_at,v_object.created_at)<p_before then
        if p_scope='public' then
          if public.xelay_public_media_attributable(to_jsonb(v_object))
            and not public.xelay_public_media_referenced(v_bucket,v_object.name)
            and not exists(select 1 from public.public_media_cleanup_claims c
              where c.bucket_id=v_bucket and c.storage_path=v_object.name and c.expires_at>clock_timestamp()) then
            v_result:=v_result||jsonb_build_array(jsonb_build_object('bucket_id',v_bucket,'name',v_object.name,'object_id',v_object.id));
          end if;
        else
          if not public.xelay_private_media_attached(v_bucket,v_object.name)
            and not exists(select 1 from public.private_media_cleanup_claims c
              where c.bucket_id=v_bucket and c.storage_path=v_object.name and c.expires_at>clock_timestamp()) then
            v_result:=v_result||jsonb_build_array(jsonb_build_object('bucket_id',v_bucket,'name',v_object.name,'object_id',v_object.id));
          end if;
        end if;
      end if;
      if jsonb_array_length(v_result)>=p_limit then
        update public.media_cleanup_bucket_cursors set last_storage_path=v_last,
          updated_at=clock_timestamp() where bucket_id=v_bucket;
        return v_result;
      end if;
    end loop;
    -- A complete short page (including zero rows) wraps on the next visit.
    -- Do not rescan it in this call; other buckets still receive their pages.
    update public.media_cleanup_bucket_cursors set last_storage_path=case when v_seen<v_per_bucket then '' else v_last end,
      updated_at=clock_timestamp() where bucket_id=v_bucket;
  end loop;
  return v_result;
end;
$$;
revoke all on function public.xelay_media_cleanup_scan_candidates(text,timestamptz,integer)
  from public,anon,authenticated,service_role;

create or replace function public.xelay_public_media_cleanup_candidates(
  p_before timestamptz default clock_timestamp()-interval '1 day',p_limit integer default 100)
returns jsonb language sql security definer set search_path = ''
as $$select public.xelay_media_cleanup_scan_candidates('public',p_before,p_limit)$$;
create or replace function public.xelay_private_media_cleanup_candidates(
  p_before timestamptz default clock_timestamp()-interval '1 day',p_limit integer default 100)
returns jsonb language sql security definer set search_path = ''
as $$select public.xelay_media_cleanup_scan_candidates('private',p_before,p_limit)$$;
revoke all on function public.xelay_public_media_cleanup_candidates(timestamptz,integer),
  public.xelay_private_media_cleanup_candidates(timestamptz,integer) from public,anon,authenticated,service_role;
grant execute on function public.xelay_public_media_cleanup_candidates(timestamptz,integer),
  public.xelay_private_media_cleanup_candidates(timestamptz,integer) to service_role;

comment on table public.media_cleanup_bucket_cursors is 'Internal bounded Storage name-page positions; no client grants, no content rows and no Realtime publication.';
comment on table public.media_cleanup_bucket_rotation is 'Internal start-bucket rotation prevents early-result starvation across private/public buckets.';
-- The old public_media_cleanup_scan_cursor remains intact for schema/data
-- compatibility. Its timestamp position is no longer used by candidate RPCs.
commit;
