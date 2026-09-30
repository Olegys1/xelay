-- Optional second link for a lesson. The original online_url and access policies remain in place.
begin;

alter table public.study_group_schedule
  add column if not exists online_url_secondary text
    constraint study_group_schedule_secondary_url_check
    check (
      online_url_secondary is null
      or online_url_secondary ~* '^https?://[^/?#[:space:]]+([/?#][^[:space:]]*)?$'
    );

comment on column public.study_group_schedule.online_url_secondary is
  'Optional second HTTP(S) link to a scheduled lesson; the first link remains in online_url.';

notify pgrst, 'reload schema';

commit;
