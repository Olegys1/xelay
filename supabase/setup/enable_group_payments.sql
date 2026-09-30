-- Run in the Supabase SQL Editor only AFTER the live merchant, callback,
-- purchase and refund have been verified. This does not enable WayForPay.
-- Until then, leave enforce_group_payment=false (the migration default).
begin;
do $$
begin
  if to_regclass('public.billing_settings') is null
    or to_regclass('public.billing_audit_log') is null then
    raise exception 'Apply the participant billing migration first';
  end if;
  if not exists(select 1 from public.billing_settings where singleton) then
    raise exception 'Billing settings are missing';
  end if;
end;
$$;
update public.billing_settings
set enforce_group_payment=true, updated_at=now()
where singleton and not enforce_group_payment;
insert into public.billing_audit_log(action,detail)
values('set_group_enforcement', jsonb_build_object(
  'enabled',true,
  'reason','Live group payments verified; enabled by database administrator',
  'source','supabase_sql_editor'
));
commit;
