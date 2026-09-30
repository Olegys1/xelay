-- Read-only diagnostics: run in Supabase SQL Editor.
-- No licenses, payment flags, groups or schedules are changed.
-- Requires the participant billing migration (202609300001).

select
  row_number() over (order by g.created_at, g.id) as "Черга створення",
  g.group_name as "Група",
  g.id as "ID групи",
  g.created_at as "Створена",
  e.source as "Тип доступу",
  (e.group_id is not null and e.revoked_at is null) as "Доступ активний",
  e.revoked_at as "Доступ відкликано",
  s.first_free_group_claimed as "Подарунок уже видано",
  s.enforce_group_payment as "Обов’язкову оплату увімкнено"
from public.study_groups g
left join public.group_entitlements e on e.group_id = g.id
left join public.billing_settings s on s.singleton = true
order by g.created_at, g.id;
