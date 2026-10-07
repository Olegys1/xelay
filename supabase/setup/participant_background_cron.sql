-- Optional operational setup AFTER the code is deployed and migrations 070004-070007 applied.
-- In Supabase Vault, create xelay_participant_origin (HTTPS site origin, no path)
-- and xelay_participant_worker_secret (same as Vercel PARTICIPANT_WORKER_SECRET).
-- Values belong in Vault, not in this file, browser URLs or job command text.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $$
declare v_origin text; v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null then raise exception 'Supabase Vault is required'; end if;
  select decrypted_secret into v_origin from vault.decrypted_secrets where name='xelay_participant_origin';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name='xelay_participant_worker_secret';
  if v_origin is null or v_origin !~ '^https://[A-Za-z0-9.-]+$' then raise exception 'Add HTTPS origin as xelay_participant_origin in Vault'; end if;
  if v_secret is null or length(v_secret)<32 or v_secret ~ '[[:space:]]' then raise exception 'Add worker credential as xelay_participant_worker_secret in Vault'; end if;
  if to_regprocedure('public.xelay_participant_worker_heartbeat()') is null
    or to_regprocedure('public.xelay_claim_participant_push(integer)') is null then raise exception 'Apply participant feature migrations first'; end if;
end;
$$;
select cron.schedule('xelay-participant-background','* * * * *',$job$
  select net.http_post(
    url:=(select decrypted_secret from vault.decrypted_secrets where name='xelay_participant_origin')||'/api/participant/worker',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||
      (select decrypted_secret from vault.decrypted_secrets where name='xelay_participant_worker_secret')),
    body:='{}'::jsonb,timeout_milliseconds:=55000
  );
$job$);
commit;
