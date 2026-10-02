-- Faculty-scoped educational programs. Existing profiles keep their legacy
-- specialty text until their academic selection is explicitly changed.
begin;

do $$
begin
  if to_regclass('public.universities') is null
    or to_regclass('public.academic_units') is null
    or to_regclass('public.profiles') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or to_regprocedure('public.xelay_create_registration_profile()') is null
  then
    raise exception 'Apply university/profile and email-confirmation migrations before academic specialties';
  end if;
end;
$$;

create table if not exists public.academic_specialties (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete restrict,
  academic_unit_id uuid not null,
  code text not null check (length(btrim(code)) between 1 and 32),
  specialty_name text not null check (length(btrim(specialty_name)) between 1 and 240),
  name text not null check (length(btrim(name)) between 1 and 512),
  source_url text check (source_url is null or source_url ~* '^https?://'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint academic_specialties_unit_university_fkey
    foreign key (academic_unit_id, university_id)
    references public.academic_units(id, university_id) on delete restrict,
  constraint academic_specialties_program_unique unique (academic_unit_id, code, name),
  constraint academic_specialties_scope_unique unique (id, academic_unit_id, university_id)
);

create index if not exists academic_specialties_active_unit_idx
  on public.academic_specialties (university_id, academic_unit_id, code, name)
  where is_active;

alter table public.academic_specialties enable row level security;
revoke all on public.academic_specialties from public, anon, authenticated;
grant select on public.academic_specialties to anon, authenticated;
grant insert, update, delete on public.academic_specialties to authenticated;

drop policy if exists "Active academic specialties are visible" on public.academic_specialties;
create policy "Active academic specialties are visible"
  on public.academic_specialties for select to anon, authenticated
  using (
    is_active and exists (
      select 1 from public.academic_units unit
      join public.universities university on university.id = unit.university_id
      where unit.id = academic_specialties.academic_unit_id
        and unit.university_id = academic_specialties.university_id
        and unit.is_active and university.is_active
    )
  );

drop policy if exists "Platform admins manage academic specialties" on public.academic_specialties;
create policy "Platform admins manage academic specialties"
  on public.academic_specialties for all to authenticated
  using (public.xelay_is_platform_admin())
  with check (public.xelay_is_platform_admin());

-- These guards keep catalog writes admin-only even if a deployed database has
-- an additional permissive policy. Reads of inactive rows are admin-only too.
drop policy if exists "Anonymous academic specialty read guard" on public.academic_specialties;
create policy "Anonymous academic specialty read guard" on public.academic_specialties
  as restrictive for select to anon
  using (
    is_active and exists (
      select 1 from public.academic_units unit
      join public.universities university on university.id = unit.university_id
      where unit.id = academic_specialties.academic_unit_id
        and unit.university_id = academic_specialties.university_id
        and unit.is_active and university.is_active
    )
  );
drop policy if exists "Authenticated academic specialty read guard" on public.academic_specialties;
create policy "Authenticated academic specialty read guard" on public.academic_specialties
  as restrictive for select to authenticated
  using (
    public.xelay_is_platform_admin() or (
      is_active and exists (
        select 1 from public.academic_units unit
        join public.universities university on university.id = unit.university_id
        where unit.id = academic_specialties.academic_unit_id
          and unit.university_id = academic_specialties.university_id
          and unit.is_active and university.is_active
      )
    )
  );
drop policy if exists "Academic specialty insert guard" on public.academic_specialties;
create policy "Academic specialty insert guard" on public.academic_specialties
  as restrictive for insert to authenticated with check (public.xelay_is_platform_admin());
drop policy if exists "Academic specialty update guard" on public.academic_specialties;
create policy "Academic specialty update guard" on public.academic_specialties
  as restrictive for update to authenticated
  using (public.xelay_is_platform_admin()) with check (public.xelay_is_platform_admin());
drop policy if exists "Academic specialty delete guard" on public.academic_specialties;
create policy "Academic specialty delete guard" on public.academic_specialties
  as restrictive for delete to authenticated using (public.xelay_is_platform_admin());

alter table public.profiles add column if not exists specialty_id uuid;
alter table public.profiles drop constraint if exists profiles_specialty_scope_fkey;
alter table public.profiles add constraint profiles_specialty_scope_fkey
  foreign key (specialty_id, academic_unit_id, university_id)
  references public.academic_specialties(id, academic_unit_id, university_id)
  on delete restrict;

create index if not exists profiles_specialty_scope_idx
  on public.profiles (specialty_id, academic_unit_id, university_id)
  where specialty_id is not null;

-- KNU_CATALOG_SEED_START
-- Programs published by KNU in 2026. Degree/form duplicates are merged.
-- Source URLs are retained per program; IDs stay stable when this seed is rerun.
do $knu_seed$
declare
  v_catalog jsonb := $knu_programs$
[
  {"university_slug":"knu","unit_slug":"biology-medicine","code":"E1","specialty_name":"Біологія та біохімія","name":"Біологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"biology-medicine","code":"E2","specialty_name":"Екологія","name":"Екологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"biology-medicine","code":"G21","specialty_name":"Біотехнології та біоінженерія","name":"Біотехнологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"biology-medicine","code":"H3","specialty_name":"Садово-паркове господарство","name":"Ландшафтне планування та озеленення","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"biology-medicine","code":"H3","specialty_name":"Садово-паркове господарство","name":"Ландшафтне планування урбанізованого середовища","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"biology-medicine","code":"I2","specialty_name":"Медицина","name":"Медицина","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"biology-medicine","code":"I2","specialty_name":"Медицина","name":"Медицина (мова навчання англійська) / Medicine","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"biology-medicine","code":"I6","specialty_name":"Технології медичної діагностики та лікування (за спеціалізаціями)","name":"Лабораторна діагностика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"chemistry","code":"E3","specialty_name":"Хімія","name":"Хімія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"computer-science-cybernetics","code":"F1","specialty_name":"Прикладна математика","name":"Прикладна математика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"computer-science-cybernetics","code":"F2","specialty_name":"Інженерія програмного забезпечення","name":"Програмна інженерія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"computer-science-cybernetics","code":"F2","specialty_name":"Інженерія програмного забезпечення","name":"Програмне забезпечення систем","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"computer-science-cybernetics","code":"F3","specialty_name":"Комп’ютерні науки","name":"Інноваційні технології в комп'ютерних аналітичних системах","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"computer-science-cybernetics","code":"F3","specialty_name":"Комп’ютерні науки","name":"Інформатика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"computer-science-cybernetics","code":"F3","specialty_name":"Комп’ютерні науки","name":"Математичні методи штучного інтелекту","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"computer-science-cybernetics","code":"F3","specialty_name":"Комп’ютерні науки","name":"Штучний інтелект","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"computer-science-cybernetics","code":"F4","specialty_name":"Системний аналіз та наука про дані","name":"Аналіз соціальних даних","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"computer-science-cybernetics","code":"F4","specialty_name":"Системний аналіз та наука про дані","name":"Системи і методи прийняття рішень","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"computer-science-cybernetics","code":"F4","specialty_name":"Системний аналіз та наука про дані","name":"Системний аналіз","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"computer-science-cybernetics","code":"F5","specialty_name":"Кібербезпека та захист інформації","name":"Інтелектуальні технології кіберзахисту","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"continuing-education","code":"C4","specialty_name":"Психологія","name":"Практична психологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"continuing-education","code":"C4","specialty_name":"Психологія","name":"Психологія сім'ї з основами консультування","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"continuing-education","code":"D2","specialty_name":"Фінанси; банківська справа; страхування та фондовий ринок","name":"Управління фінансами","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"continuing-education","code":"D3","specialty_name":"Менеджмент","name":"Менеджмент організацій охорони здоров'я","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"continuing-education","code":"D7","specialty_name":"Торгівля","name":"Електронні торги, фінансовий аналіз та FinTech","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"continuing-education","code":"D8","specialty_name":"Право","name":"Правнича діяльність","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"continuing-education","code":"D8","specialty_name":"Право","name":"Приватне та публічне право","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"C1.01","specialty_name":"Економіка та міжнародні економічні відносини — Економіка","name":"Економіка","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"C1.01","specialty_name":"Економіка та міжнародні економічні відносини — Економіка","name":"Економіка (мова навчання англійська/українська) / Economics","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"C1.01","specialty_name":"Економіка та міжнародні економічні відносини — Економіка","name":"Економіка та економічна політика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"C1.01","specialty_name":"Економіка та міжнародні економічні відносини — Економіка","name":"Економіка та політика (мова навчання англійська/українська) / Economics and Politics","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"C1.01","specialty_name":"Економіка та міжнародні економічні відносини — Економіка","name":"Економічна аналітика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"C1.01","specialty_name":"Економіка та міжнародні економічні відносини — Економіка","name":"Економічна кібернетика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"C1.01","specialty_name":"Економіка та міжнародні економічні відносини — Економіка","name":"Міжнародна економіка","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"CD88","specialty_name":"Економіка та міжнародні економічні відносини / Менеджмент","name":"Економіка та управління бізнесом","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D1","specialty_name":"Облік і оподаткування","name":"Облік і оподаткування","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D1","specialty_name":"Облік і оподаткування","name":"Облік, оподаткування та контроль","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D2","specialty_name":"Фінанси; банківська справа; страхування та фондовий ринок","name":"Корпоративні фінанси","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D2","specialty_name":"Фінанси; банківська справа; страхування та фондовий ринок","name":"Фінанси","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D2","specialty_name":"Фінанси; банківська справа; страхування та фондовий ринок","name":"Фінанси публічного сектору / Public Sector Finance (З можливістю подвійного дипломування разом з Норд Університетом, Норвегія)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D2","specialty_name":"Фінанси; банківська справа; страхування та фондовий ринок","name":"Фінансовий бізнес","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D2","specialty_name":"Фінанси; банківська справа; страхування та фондовий ринок","name":"Фінансові інститути та управління ризиками","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D3","specialty_name":"Менеджмент","name":"Бізнес-консалтинг","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D3","specialty_name":"Менеджмент","name":"Менеджмент інноваційної діяльності","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D3","specialty_name":"Менеджмент","name":"Менеджмент організацій","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D3","specialty_name":"Менеджмент","name":"Менеджмент підприємницької діяльності","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D5","specialty_name":"Маркетинг","name":"Бізнес-адміністрування і консультування (мова навчання англійська/українська) З можливістю подвійного дипломування з Університетом Мачерата, Італія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"economics","code":"D5","specialty_name":"Маркетинг","name":"Маркетинг","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"A4.07","specialty_name":"Середня освіта — Географія","name":"Географія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"A4.15","specialty_name":"Середня освіта — Природничі науки","name":"Природничі науки. Інтегрована програма","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"C6","specialty_name":"Географія та регіональні студії","name":"Африканістика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"C6","specialty_name":"Географія та регіональні студії","name":"Економічна географія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"C6","specialty_name":"Географія та регіональні студії","name":"Політична географія та геополітика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"C6","specialty_name":"Географія та регіональні студії","name":"Проєктування та геобрендинг рекреаційних територій","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"C6","specialty_name":"Географія та регіональні студії","name":"Транскордонне природоохоронне співробітництво","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"C6","specialty_name":"Географія та регіональні студії","name":"Урбаністика та міське планування","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"C6","specialty_name":"Географія та регіональні студії","name":"Урбаністика та регіональний розвиток","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"E4","specialty_name":"Науки про Землю","name":"Геоекологія та екосистемні послуги","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"E4","specialty_name":"Науки про Землю","name":"Гідрологія, використання та збереження водних ресурсів","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"E4","specialty_name":"Науки про Землю","name":"Гідрологія, водні ресурси і стале водокористування","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"E4","specialty_name":"Науки про Землю","name":"Ґрунтознавство, земельні ресурси та територіальне планування","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"E4","specialty_name":"Науки про Землю","name":"Картографія та геоінформаційні системи","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"E4","specialty_name":"Науки про Землю","name":"Метеорологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"G18","specialty_name":"Геодезія та землеустрій","name":"Геодезія та землеустрій","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"G18","specialty_name":"Геодезія та землеустрій","name":"Землеустрій та кадастр","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geography","code":"J3","specialty_name":"Туризм та рекреація","name":"Туризм","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geology","code":"E4","specialty_name":"Науки про Землю","name":"Геоінформатика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geology","code":"E4","specialty_name":"Науки про Землю","name":"Геологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geology","code":"E4","specialty_name":"Науки про Землю","name":"Геологія нафти і газу","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geology","code":"E4","specialty_name":"Науки про Землю","name":"Геологія та надрокористування","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geology","code":"E4","specialty_name":"Науки про Землю","name":"Геохімія і мінералогія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geology","code":"E4","specialty_name":"Науки про Землю","name":"Гідрогеологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geology","code":"E4","specialty_name":"Науки про Землю","name":"Промислова геофізика і петрофізика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geology","code":"G18","specialty_name":"Геодезія та землеустрій","name":"Геоінформаційні системи та технології","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"geology","code":"G18","specialty_name":"Геодезія та землеустрій","name":"Оцінка землі та нерухомого майна","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"high-technologies","code":"E1","specialty_name":"Біологія та біохімія","name":"Біоінформатика і структурна біологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"high-technologies","code":"E1","specialty_name":"Біологія та біохімія","name":"Біологія та біоінформатика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"high-technologies","code":"E3","specialty_name":"Хімія","name":"Медична хімія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"high-technologies","code":"E3","specialty_name":"Хімія","name":"Хемоінформатика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"high-technologies","code":"E6","specialty_name":"Прикладна фізика та наноматеріали","name":"Прикладна фізика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"high-technologies","code":"EE88","specialty_name":"Хімія/Біологія та біохімія","name":"Хімія біомолекул","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"high-technologies","code":"EF88","specialty_name":"Прикладна фізика та наноматеріали/ Інформаційні системи і технології","name":"Фізика інформаційних технологій","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"high-technologies","code":"G5","specialty_name":"Електроніка; електронні комунікації; приладобудування та радіотехніка","name":"Електроніка","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"A4.03","specialty_name":"Середня освіта — Історія та громадянська освіта","name":"Середня освіта (Історія)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B12","specialty_name":"Культурологія та музеєзнавство","name":"Музеєзнавство, пам'яткознавство","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B13","specialty_name":"Бібліотечна; інформаційна та архівна справа","name":"Архівістика, документаційна та інформаційна діяльність","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Американістика та європейські студії","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Американістика та європейські студії (з поглибленим вивченням іноземних мов)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Археологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Археологія та преісторія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Візуальна історія та кураторство виставкових проєктів","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Етнологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Закордонне українство: історія та сучасність (з поглибленим вивченням іноземних мов)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Історія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Історія мистецтв","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Історія України","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Історія України та культурна антропологія (з поглибленим вивченням іноземних мов)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Східноєвропейські історичні студії","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"B9","specialty_name":"Історія та археологія","name":"Сходознавство","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"history","code":"BJ88","specialty_name":"Історія та археологія/Туризм та рекреація","name":"Історико-культурний туризм","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F2","specialty_name":"Інженерія програмного забезпечення","name":"Інженерія програмного забезпечення","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F3","specialty_name":"Комп’ютерні науки","name":"Аналітика даних","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F3","specialty_name":"Комп’ютерні науки","name":"Генеративний штучний інтелект","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F3","specialty_name":"Комп’ютерні науки","name":"Інформаційна аналітика та впливи","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F3","specialty_name":"Комп’ютерні науки","name":"ІТ-проєкти","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F3","specialty_name":"Комп’ютерні науки","name":"Комп'ютерні науки","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F3","specialty_name":"Комп’ютерні науки","name":"Прикладне програмування","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F3","specialty_name":"Комп’ютерні науки","name":"Системна інформатика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F3","specialty_name":"Комп’ютерні науки","name":"Технології розробки ІТ-проєктів","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F5","specialty_name":"Кібербезпека та захист інформації","name":"Кібербезпека","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F6","specialty_name":"Інформаційні системи і технології","name":"Програмні технології інтернет речей","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"F6","specialty_name":"Інформаційні системи і технології","name":"Технології веброзробки та вебдизайн","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"information-technology","code":"G5","specialty_name":"Електроніка; електронні комунікації; приладобудування та радіотехніка","name":"Мережеві та інтернет технології","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"BC88","specialty_name":"Міжнародні відносини / Філологія","name":"Міжнародні відносини і переклад","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C1","specialty_name":"Економіка та міжнародні економічні відносини","name":"Міжнародна комерція та інвестиції (мова навчання англійська) / International Commerce And Investment","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C1.02","specialty_name":"Економіка та міжнародні економічні відносини — Міжнародні економічні відносини","name":"Міжнародна комерція та інвестиції","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C1.02","specialty_name":"Економіка та міжнародні економічні відносини — Міжнародні економічні відносини","name":"Міжнародна комерція та інвестиції (мова навчання англійська) / International Commerce And Investment","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C1.02","specialty_name":"Економіка та міжнародні економічні відносини — Міжнародні економічні відносини","name":"Міжнародні економічні відносини","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C1.02","specialty_name":"Економіка та міжнародні економічні відносини — Міжнародні економічні відносини","name":"Міжнародні економічні відносини (з обов'язковим вивченням двох іноземних мов)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C3","specialty_name":"Міжнародні відносини","name":"Дипломатія і міжнародне співробітництво","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C3","specialty_name":"Міжнародні відносини","name":"Зовнішня політика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C3","specialty_name":"Міжнародні відносини","name":"Зовнішня політика та безпекові студії","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C3","specialty_name":"Міжнародні відносини","name":"Країнознавство (американістика, сходознавство, європейські студії, африканістика) (з обов'язковим вивченням двох іноземних мов)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C3","specialty_name":"Міжнародні відносини","name":"Міжнародне регіонознавство","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C3","specialty_name":"Міжнародні відносини","name":"Міжнародні відносини","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C3","specialty_name":"Міжнародні відносини","name":"Міжнародні відносини (з обов’язковим вивченням двох іноземних мов)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C3","specialty_name":"Міжнародні відносини","name":"Міжнародні комунікації","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C3","specialty_name":"Міжнародні відносини","name":"Міжнародні комунікації (з обов’язковим вивченням двох іноземних мов)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C3","specialty_name":"Міжнародні відносини","name":"Міжнародні комунікації (міжнародні медіа студії)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"C3","specialty_name":"Міжнародні відносини","name":"Міжнародні медіа студії","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"CC88","specialty_name":"Економіка та міжнародні економічні відносини / Географія та регіональні студії","name":"Міжнародне інвестування сталого розвитку","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"CD88","specialty_name":"Економіка та міжнародні економічні відносини / Менеджмент","name":"Менеджмент міжнародного бізнесу (мова навчання українська/англійська)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"CD88","specialty_name":"Економіка та міжнародні економічні відносини / Менеджмент","name":"Міжнародний бізнес","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"CD88","specialty_name":"Економіка та міжнародні економічні відносини / Менеджмент","name":"Міжнародний бізнес (з обов'язковим вивченням двох іноземних мов)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"CD88","specialty_name":"Економіка та міжнародні економічні відносини / Фінанси; банківська справа; страхування та фондовий ринок","name":"Міжнародні фінанси та інвестиції","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"CDD888","specialty_name":"Економіка та міжнародні економічні відносини / Менеджмент / Маркетинг","name":"Міжнародний бізнес (менеджмент та маркетинг)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"D9","specialty_name":"Міжнародне право","name":"Європейське бізнесове право (мова навчання українська/англійська) / European Business Law","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"D9","specialty_name":"Міжнародне право","name":"Міжнародне право","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"D9","specialty_name":"Міжнародне право","name":"Міжнародне право (мова навчання англійська) / International Law","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"international-relations","code":"D9","specialty_name":"Міжнародне право","name":"Міжнародне приватне право","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"journalism","code":"B1","specialty_name":"Аудіовізуальне мистецтво та медіавиробництво","name":"Аудіовізуальні мистецтва, медіа та виробництво","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"journalism","code":"B1","specialty_name":"Аудіовізуальне мистецтво та медіавиробництво","name":"Кіно-, телемистецтво","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"journalism","code":"C7","specialty_name":"Журналістика","name":"Бренд-комунікації","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"journalism","code":"C7","specialty_name":"Журналістика","name":"Журналістика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"journalism","code":"C7","specialty_name":"Журналістика","name":"Журналістика та медіакомунікації","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"journalism","code":"C7","specialty_name":"Журналістика","name":"Імпакт-журналістика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"journalism","code":"C7","specialty_name":"Журналістика","name":"Корпоративні медіакомунікації","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"journalism","code":"C7","specialty_name":"Журналістика","name":"Стратегічні комунікації","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"journalism","code":"C7","specialty_name":"Журналістика","name":"Тревел-журналістика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"journalism","code":"C7","specialty_name":"Журналістика","name":"Цифрові медіа","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"law","code":"D8","specialty_name":"Право","name":"Законодавча діяльність та нормопроектування в Україні","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"law","code":"D8","specialty_name":"Право","name":"Інтелектуальна власність","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"law","code":"D8","specialty_name":"Право","name":"Право","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"law","code":"D8","specialty_name":"Право","name":"Право/Правознавство","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"law","code":"D8","specialty_name":"Право","name":"Україно – Європейські правничі студії (Програма подвійного дипломування з Університетом ім.Миколаса Ромеріса в м.Вільнюс, Литва) (мова навчання англійська) / Ukrainian and European Legal Studies (Double Diploma Program in Association with the Mykolas Romeris University (Vilnius, Lithuania)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"mechanics-mathematics","code":"A4.04","specialty_name":"Середня освіта — Математика","name":"Математика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"mechanics-mathematics","code":"E7","specialty_name":"Математика","name":"Актуарна та фінансова математика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"mechanics-mathematics","code":"E7","specialty_name":"Математика","name":"Математика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"mechanics-mathematics","code":"E7","specialty_name":"Математика","name":"Математика інновацій","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"mechanics-mathematics","code":"E7","specialty_name":"Математика","name":"Математика штучного інтелекту","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"mechanics-mathematics","code":"E8","specialty_name":"Статистика","name":"Прикладна та теоретична статистика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"mechanics-mathematics","code":"E8","specialty_name":"Статистика","name":"Статистика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"B11","specialty_name":"Філологія","name":"Військовий переклад","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"B11","specialty_name":"Філологія","name":"Лінгвістичне забезпечення військ","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"C2","specialty_name":"Політологія","name":"Воєнна політологія","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"C2","specialty_name":"Політологія","name":"Осередок руху опору","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"C3","specialty_name":"Міжнародні відносини","name":"Зарубіжна воєнна інформація","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"C3","specialty_name":"Міжнародні відносини","name":"Міжнародне співробітництво у сфері оборони та воєнній сфері","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"C3","specialty_name":"Міжнародні відносини","name":"Міжнародні комунікації у воєнній сфері","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"C4","specialty_name":"Психологія","name":"Військова психологія","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"C4","specialty_name":"Психологія","name":"Психологія військово-професійної діяльності","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"C7","specialty_name":"Журналістика","name":"Військова журналістика та соціальні комунікації","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"C7","specialty_name":"Журналістика","name":"Зв'язки з громадськістю в Збройних Силах України","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"D1","specialty_name":"Облік і оподаткування","name":"Внутрішній аудит","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"D2","specialty_name":"Фінанси, банківська справа, страхування та фондовий ринок","name":"Фінанси у воєнній сфері","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"D8","specialty_name":"Право","name":"Забезпечення правопорядку в Збройних Силах України","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"D8","specialty_name":"Право","name":"Організація правозастосовної діяльності в Збройних Силах України","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"D8","specialty_name":"Право","name":"Цивільно-військові відносини","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"G18","specialty_name":"Геодезія та землеустрій","name":"Геоінформаційні системи і технології","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"military-institute","code":"I10","specialty_name":"Соціальна робота та консультування","name":"Соціальна робота у військах (силах)","source_url":"https://viknu.mil.gov.ua/"},
  {"university_slug":"knu","unit_slug":"philology","code":"A4.01","specialty_name":"Середня освіта — Українська мова і література","name":"Теорія та методика навчання української мови і літератури та іноземної мови в старшій профільній школі","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"A4.01","specialty_name":"Середня освіта — Українська мова і література","name":"Теорія та методика навчання української мови і літератури, іноземної мови в основній школі","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"A4.021","specialty_name":"Середня освіта — Англійська мова та зарубіжна література","name":"Зарубіжна література та англійська мова: теорія і методика навчання","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"A4.021","specialty_name":"Середня освіта — Англійська мова та зарубіжна література","name":"Зарубіжна література та англійська мова: теорія та методика навчання","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"A4.029","specialty_name":"Середня освіта — Турецька мова та зарубіжна література","name":"Турецька мова і література та англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.01","specialty_name":"Філологія — Українська мова та література","name":"Літературна творчість, українська мова і література та англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.01","specialty_name":"Філологія — Українська мова та література","name":"Літературно-мистецька аналітика та західноєвропейська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.01","specialty_name":"Філологія — Українська мова та література","name":"Українська і англійська мови: переклад та редагування","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.01","specialty_name":"Філологія — Українська мова та література","name":"Українська мова і література та західноєвропейська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.01","specialty_name":"Філологія — Українська мова та література","name":"Українська мова та література (для іноземців, мова навчання українська)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.01","specialty_name":"Філологія — українська мова та література","name":"Українська мова та переклад (для іноземців) (мова навчання українська)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.01","specialty_name":"Філологія — Українська мова та література","name":"Українська мова як іноземна та англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.01","specialty_name":"Філологія — Українська мова та література","name":"Українська філологія та західноєвропейська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.01","specialty_name":"Філологія — Українська мова та література","name":"Юрислінгвістика та переклад","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.02","specialty_name":"Філологія — Кримськотатарська мова та література","name":"Кримськотатарська мова і література, англійська мова та переклад","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.02","specialty_name":"Філологія — Кримськотатарська мова та література","name":"Кримськотатарська філологія, англійська мова та переклад","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.031","specialty_name":"Філологія — Слов’янські мови та літератури (переклад включно); перша - білоруська","name":"Білоруська мова і література, українська мова і література, англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.032","specialty_name":"Філологія — Слов’янські мови та літератури (переклад включно); перша - болгарська","name":"Болгарська мова і література та англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.033","specialty_name":"Філологія — Слов'янські мови та літератури (переклад включно); перша - польська","name":"Польська мова і література, англійська та литовська мови","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.033","specialty_name":"Філологія — Слов'янські мови та літератури (переклад включно); перша - польська","name":"Славістика Центрально-Східної Європи і Балкан: теоретичні та прикладні студії: польська та українська мови і літератури","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.035","specialty_name":"Філологія — Слов’янські мови та літератури (переклад включно); перша - сербська","name":"Сербська мова і література та англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.035","specialty_name":"Філологія — Слов'янські мови та літератури (переклад включно); перша - сербська","name":"Славістика Центрально-Східної Європи і Балкан: теоретичні та прикладні студії: сербська та українська мови і літератури","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.038","specialty_name":"Філологія — Слов`янські мови та літератури (переклад включно); перша – чеська","name":"Чеська мова і література та англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.041","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - англійська","name":"Англійська мова та література (мова навчання англійська) / English Language and Literature","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.041","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - англійська","name":"Англійська філологія та дві іноземні мови (мова навчання англійська) / English Studies and Two Foreign Languages","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.041","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - англійська","name":"Англійська філологія та переклад, дві західноєвропейські мови","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.041","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - англійська","name":"Переклад з англійської та другої західноєвропейської мови","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.041","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - англійська","name":"Сучасна англомовна комунікація та переклад і дві західноєвропейські мови / English Communication Studies and Translation and two Western European Languages (викладання іноземними мовами)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.041","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - англійська","name":"Усний та письмовий переклад з англійської та другої західноєвропейської мови","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.041","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - англійська","name":"Художній переклад з англійської мови, літературне редагування та менеджмент перекладацьких проектів","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.043","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - німецька","name":"Галузевий переклад з німецької та англійської мови; міжкультурний менеджмент","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.043","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - німецька","name":"Міжкультурна германістика (німецька та англійська мови)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.043","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - німецька","name":"Німецька філологія та переклад, англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.043","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - німецька","name":"Переклад з німецької та англійської мов","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.044","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - шведська","name":"Германська філологія і переклад (шведська мова та англійська мова)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.044","specialty_name":"Філологія — Германські мови та літератури (переклад включно); перша - шведська","name":"Шведська філологія та переклад, англійська мова та третя германська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.051","specialty_name":"Філологія — Романські мови та літератури (переклад включно); перша - іспанська","name":"Загальний і галузевий усний та письмовий переклад з іспанської та англійської мов","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.051","specialty_name":"Філологія — Романські мови та літератури (переклад включно); перша - іспанська","name":"Іспаномовні студії та переклад, англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.051","specialty_name":"Філологія — Романські мови та літератури (переклад включно); перша - іспанська","name":"Іспанська мова та переклад, англійська мова та друга романська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.051","specialty_name":"Філологія — Романські мови та літератури (переклад включно); перша - іспанська","name":"Переклад з іспанської та з англійської мов","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.052","specialty_name":"Філологія — Романські мови та літератури (переклад включно); перша - італійська","name":"Загальний і галузевий усний та письмовий переклад з італійської та англійської мов","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.052","specialty_name":"Філологія — Романські мови та літератури (переклад включно); перша - італійська","name":"Переклад з італійської та з англійської мов","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.053","specialty_name":"Філологія — Романські мови та літератури (переклад включно); перша - португальська","name":"Переклад із португальської та з англійської мов","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.055","specialty_name":"Філологія — Романські мови та літератури (переклад включно); перша - французька","name":"Загальний і галузевий усний та письмовий переклад з французької та англійської мов","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.055","specialty_name":"Філологія — Романські мови та літератури (переклад включно); перша - французька","name":"Переклад з французької та з англійської мов","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.055","specialty_name":"Філологія — Романські мови та літератури (переклад включно); перша - французька","name":"Франкофонні студії та переклад, англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.055","specialty_name":"Філологія — Романські мови та літератури (переклад включно); перша - французька","name":"Французька мова та переклад, англійська мова та друга романська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.060","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - арабська","name":"Арабська мова і література та переклад, французька мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.060","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - арабська","name":"Східна філологія, західноєвропейська мова та переклад: арабська мова і література","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.061","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - в'єтнамська","name":"В'єтнамська мова і література та переклад, французька мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.062","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - гінді","name":"Мова і література гінді та переклад, англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.062","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - ґінді","name":"Східна філологія, західноєвропейська мова та переклад: мова і література гінді","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.064","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - індонезійська","name":"Індонезійська мова і література та переклад, західноєвропейська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.065","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - китайська","name":"Китайська мова і література та переклад, англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.065","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - китайська","name":"Східна філологія, західноєвропейська мова та переклад: китайська мова і література","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.066","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - корейська","name":"Корейська мова і література та переклад, англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.066","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - корейська","name":"Східна філологія, західноєвропейська мова та переклад: корейська мова і література","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.067","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - перська","name":"Перська мова і література та переклад, англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.067","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша – перська","name":"Східна філологія, західноєвропейська мова та переклад: перська мова і література","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.068","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - турецька","name":"Східна філологія, західноєвропейська мова та переклад: турецька мова і література","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.068","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - турецька","name":"Турецька мова і література та переклад, англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.069","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - японська","name":"Східна філологія, західноєвропейська мова та переклад: японська мова і література","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.069","specialty_name":"Філологія — Східні мови та літератури (переклад включно); перша - японська","name":"Японська мова і література та переклад, англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.08","specialty_name":"Філологія — Класичні мови та літератури (переклад включно)","name":"Класична філологія та англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.08","specialty_name":"Філологія — Класичні мови та літератури (переклад включно)","name":"Класичні студії та західноєвропейська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.081","specialty_name":"Філологія — Новогрецька мова і література (переклад включно)","name":"Новогрецька філологія та переклад і англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.081","specialty_name":"Філологія — Новогрецька мова і література (переклад включно)","name":"Новогрецька філологія, англійська мова та переклад","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.09","specialty_name":"Філологія — Фольклористика","name":"Фольклористика, міжкультурна комунікація, іноземна мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.09","specialty_name":"Філологія — Фольклористика","name":"Фольклористика, українська мова і література та іноземна мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.10","specialty_name":"Філологія — Прикладна лінгвістика","name":"Прикладна (комп’ютерна) лінгвістика та англійська мова","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.10","specialty_name":"Філологія — Прикладна лінгвістика","name":"Прикладна лінгвістика (редакторсько-перекладацька та експертна діяльність)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.10","specialty_name":"Філологія — Прикладна лінгвістика","name":"Прикладна лінгвістика: експертна аналітика у галузі стратегічних комунікацій та переклад","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B11.10","specialty_name":"Філологія — Прикладна лінгвістика","name":"Прикладні східнослов’янські студії та англійська мова: технології мовного впливу і переклад","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B12","specialty_name":"Культурологія та музеєзнавство","name":"Етнокультурологія з поглибленим вивченням іноземної мови","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philology","code":"B12","specialty_name":"Культурологія та музеєзнавство","name":"Культурна антропологія з фаховим вивченням іноземної мови","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philosophy","code":"B10","specialty_name":"Філософія","name":"Прикладна філософія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philosophy","code":"B10","specialty_name":"Філософія","name":"Філософія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philosophy","code":"B12","specialty_name":"Культурологія та музеєзнавство","name":"Культурологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philosophy","code":"B7","specialty_name":"Релігієзнавство","name":"Релігієзнавство","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"philosophy","code":"C2","specialty_name":"Політологія","name":"Політологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"physics","code":"A4.08","specialty_name":"Середня освіта — Фізика та астрономія","name":"Фізика та інформатика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"physics","code":"E5","specialty_name":"Фізика та астрономія","name":"Астрономія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"physics","code":"E5","specialty_name":"Фізика та астрономія","name":"Астрофізика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"physics","code":"E5","specialty_name":"Фізика та астрономія","name":"Квантова теорія поля","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"physics","code":"E5","specialty_name":"Фізика та астрономія","name":"Квантова теорія поля, теоретична та математична фізика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"physics","code":"E5","specialty_name":"Фізика та астрономія","name":"Медична фізика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"physics","code":"E5","specialty_name":"Фізика та астрономія","name":"Оптика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"physics","code":"E5","specialty_name":"Фізика та астрономія","name":"Оптика, лазерна фізика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"physics","code":"E5","specialty_name":"Фізика та астрономія","name":"Фізика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"physics","code":"E5","specialty_name":"Фізика та астрономія","name":"Фізика високих енергій","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"physics","code":"E5","specialty_name":"Фізика та астрономія","name":"Ядерна енергетика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"psychology","code":"A1","specialty_name":"Освітні науки","name":"Педагогіка вищої школи","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"psychology","code":"C4","specialty_name":"Психологія","name":"Клінічна психологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"psychology","code":"C4","specialty_name":"Психологія","name":"Нейропсихологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"psychology","code":"C4","specialty_name":"Психологія","name":"Політична психологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"psychology","code":"C4","specialty_name":"Психологія","name":"Психологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"psychology","code":"C4","specialty_name":"Психологія","name":"Психологія дитинства і сім’ї","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"psychology","code":"I10","specialty_name":"Соціальна робота та консультування","name":"Соціальна робота","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"psychology","code":"I10","specialty_name":"Соціальна робота та консультування","name":"Соціальне відновлення та життєстійкість","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"psychology","code":"I10","specialty_name":"Соціальна робота та консультування","name":"Соціальне консультування та інклюзія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"D4","specialty_name":"Публічне управління та адміністрування","name":"Державна служба","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"D4","specialty_name":"Публічне управління та адміністрування","name":"Європейські студії для публічних управлінців (для державних службовців за замовленням Національного агентства України з питань державної служби)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"D4","specialty_name":"Публічне управління та адміністрування","name":"Європейські та євроатлантичні управлінські студії","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"D4","specialty_name":"Публічне управління та адміністрування","name":"Місцеве самоврядування","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"D4","specialty_name":"Публічне управління та адміністрування","name":"Парламентаризм та парламентська діяльність","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"D4","specialty_name":"Публічне управління та адміністрування","name":"Постконфліктне врядування","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"D4","specialty_name":"Публічне управління та адміністрування","name":"Публічне управління та адміністрування","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"D4","specialty_name":"Публічне управління та адміністрування","name":"Публічне управління та адміністрування (для державних службовців за замовленням Національного агентства України з питань державної служби)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"D4","specialty_name":"Публічне управління та адміністрування","name":"Публічне управління та адміністрування: інтеграція в ЄС","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"D4","specialty_name":"Публічне управління та адміністрування","name":"Публічний аудит","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"D4","specialty_name":"Публічне управління та адміністрування","name":"Урядування у публічній сфері","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"K3","specialty_name":"Національна безпека (за окремими сферами забезпечення та видами діяльності)","name":"Стратегічний менеджмент у сфері національної безпеки","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"public-administration","code":"K3","specialty_name":"Національна безпека (за окремими сферами забезпечення та видами діяльності)","name":"Урядування у сфері національної безпеки","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"radio-physics-electronics","code":"E6","specialty_name":"Прикладна фізика та наноматеріали","name":"Біомедична фізика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"radio-physics-electronics","code":"E6","specialty_name":"Прикладна фізика та наноматеріали","name":"Прикладна біомедична радіофізика","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"radio-physics-electronics","code":"E6","specialty_name":"Прикладна фізика та наноматеріали","name":"Прикладна фізика та наноматеріали","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"radio-physics-electronics","code":"E6","specialty_name":"Прикладна фізика та наноматеріали","name":"Прикладна фізика, наноелектроніка та мікропроцесорна техніка","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"radio-physics-electronics","code":"E6","specialty_name":"Прикладна фізика та наноматеріали","name":"Радіофізика та наноелектроніка","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"radio-physics-electronics","code":"F7","specialty_name":"Комп’ютерна інженерія","name":"Інженерія комп'ютерних систем і мереж","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"radio-physics-electronics","code":"F7","specialty_name":"Комп’ютерна інженерія","name":"Комп'ютерні системи та мережі","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"radio-physics-electronics","code":"G5","specialty_name":"Електроніка; електронні комунікації; приладобудування та радіотехніка","name":"Електронні комунікації, пристрої та системи","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"radio-physics-electronics","code":"G5","specialty_name":"Електроніка; електронні комунікації; приладобудування та радіотехніка","name":"Інженерія радіоелектронних систем","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"radio-physics-electronics","code":"G5","specialty_name":"Електроніка; електронні комунікації; приладобудування та радіотехніка","name":"Радіоелектроніка та електронні комунікації","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"sociology","code":"C5","specialty_name":"Соціологія","name":"Прикладна соціологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"sociology","code":"C5","specialty_name":"Соціологія","name":"Соціологія","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"sociology","code":"D3","specialty_name":"Менеджмент","name":"Менеджмент культурних та креативних індустрій (з обов’язковим вивченням двох іноземних мов)","source_url":"https://vstup.knu.ua/study-programs"},
  {"university_slug":"knu","unit_slug":"state-guard-management","code":"251","specialty_name":"Державна безпека","name":"Охоронна діяльність та безпека","source_url":"https://knu.ua/ua/departments/msgu/"},
  {"university_slug":"knu","unit_slug":"state-guard-management","code":"256","specialty_name":"Національна безпека (за окремими сферами забезпечення та видами діяльності)","name":"Особиста та майнова безпека","source_url":"https://knu.ua/ua/departments/msgu/"}
]
$knu_programs$::jsonb;
begin
  if exists (
    select 1
    from jsonb_to_recordset(v_catalog) as program(university_slug text, unit_slug text)
    left join public.universities university on university.slug = program.university_slug
    left join public.academic_units unit
      on unit.university_id = university.id and unit.slug = program.unit_slug
    where university.id is null or unit.id is null
  ) then
    raise exception 'KNU program catalog references missing universities or faculties; apply the university migration first';
  end if;

  insert into public.academic_specialties (
    university_id, academic_unit_id, code, specialty_name, name, source_url
  )
  select university.id, unit.id, program.code, program.specialty_name, program.name, program.source_url
  from jsonb_to_recordset(v_catalog) as program(
    university_slug text, unit_slug text, code text, specialty_name text, name text, source_url text
  )
  join public.universities university on university.slug = program.university_slug
  join public.academic_units unit
    on unit.university_id = university.id and unit.slug = program.unit_slug
  on conflict (academic_unit_id, code, name) do update set
    specialty_name = excluded.specialty_name,
    source_url = excluded.source_url,
    is_active = true;
end;
$knu_seed$;
-- KNU_CATALOG_SEED_END

create or replace function public.xelay_validate_profile_academic_specialty()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_program_name text;
  v_faculty_name text;
  v_academic_changed boolean;
begin
  if tg_op = 'UPDATE' then
    v_academic_changed := new.university_id is distinct from old.university_id
      or new.academic_unit_id is distinct from old.academic_unit_id
      or new.specialty_id is distinct from old.specialty_id
      or new.specialty is distinct from old.specialty
      or new.faculty is distinct from old.faculty;
    -- Do not force old accounts to select a program while editing an avatar,
    -- bio, notifications, or other unrelated fields. Also allow unchanged
    -- selected programs to remain on an account after catalog deactivation.
    if not v_academic_changed then return new; end if;
  elsif new.university_id is null and new.academic_unit_id is null
    and new.specialty_id is null
    and nullif(btrim(coalesce(new.specialty, '')), '') is null
    and nullif(btrim(coalesce(new.faculty, '')), '') is null
  then
    -- Some Supabase projects first insert an empty profile from auth.users.
    -- The completed Xelay signup is validated separately below and cannot
    -- complete with an empty university/faculty/program selection.
    return new;
  end if;

  if new.specialty_id is null then
    raise exception 'ACADEMIC_SPECIALTY_REQUIRED' using errcode = '23514';
  end if;
  select specialty.name, unit.name into v_program_name, v_faculty_name
    from public.academic_specialties specialty
    join public.academic_units unit
      on unit.id = specialty.academic_unit_id and unit.university_id = specialty.university_id
    join public.universities university on university.id = specialty.university_id
    where specialty.id = new.specialty_id
      and specialty.academic_unit_id = new.academic_unit_id
      and specialty.university_id = new.university_id
      and specialty.is_active and unit.is_active and university.is_active;
  if not found then
    raise exception 'ACADEMIC_SPECIALTY_INVALID' using errcode = '23514';
  end if;
  -- Client-provided display labels are never authoritative.
  new.specialty := v_program_name;
  new.faculty := v_faculty_name;
  return new;
end;
$$;

revoke all on function public.xelay_validate_profile_academic_specialty()
  from public, anon, authenticated;
drop trigger if exists xelay_profile_academic_specialty on public.profiles;
create trigger xelay_profile_academic_specialty
  before insert or update on public.profiles
  for each row execute function public.xelay_validate_profile_academic_specialty();

-- Preserve the existing confirmed-email registration flow and metadata
-- whitelist, adding only the selected educational program and its label.
create or replace function public.xelay_create_registration_profile()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_university uuid;
  v_unit uuid;
  v_specialty uuid;
  v_faculty text;
  v_program_name text;
  v_categories text[];
  v_name text;
  v_username text;
begin
  -- Ignore imports and legacy accounts; this trigger only handles our signup form.
  if v_meta->>'xelay_registration_version' is distinct from '1' then return new; end if;
  v_name := btrim(coalesce(v_meta->>'full_name', ''));
  v_username := nullif(lower(regexp_replace(btrim(coalesce(v_meta->>'username', '')), '^@', '')), '');
  if length(v_name) not between 1 and 120
    or length(btrim(coalesce(v_meta->>'country', ''))) not between 1 and 80
    or length(coalesce(v_meta->>'city', '')) > 120
    or length(coalesce(v_meta->>'bio', '')) > 2000
    or coalesce(v_meta->>'experience', '') not in ('Student / Fresh Graduate', '1–3 years', '3–7 years', '7–15 years', '15+ years')
    or (v_username is not null and v_username !~ '^[[:alnum:]][[:alnum:]_.-]{2,29}$')
  then raise exception 'Invalid registration profile'; end if;

  v_university := nullif(v_meta->>'university_id', '')::uuid;
  v_unit := nullif(v_meta->>'academic_unit_id', '')::uuid;
  v_specialty := nullif(v_meta->>'specialty_id', '')::uuid;
  if v_specialty is null then
    raise exception 'ACADEMIC_SPECIALTY_REQUIRED' using errcode = '23514';
  end if;
  select specialty.name, unit.name into v_program_name, v_faculty
    from public.academic_specialties specialty
    join public.academic_units unit
      on unit.id = specialty.academic_unit_id and unit.university_id = specialty.university_id
    join public.universities university on university.id = specialty.university_id
    where specialty.id = v_specialty
      and specialty.academic_unit_id = v_unit and specialty.university_id = v_university
      and specialty.is_active and unit.is_active and university.is_active;
  if not found then
    raise exception 'ACADEMIC_SPECIALTY_INVALID' using errcode = '23514';
  end if;
  if jsonb_typeof(v_meta->'categories') is distinct from 'array' then
    raise exception 'Invalid registration categories';
  end if;
  if jsonb_array_length(v_meta->'categories') not between 1 and 20 then
    raise exception 'Invalid registration categories';
  end if;
  if exists (select 1 from jsonb_array_elements(v_meta->'categories') category
    where jsonb_typeof(category) <> 'string' or length(category #>> '{}') not between 1 and 100)
  then raise exception 'Invalid registration categories'; end if;
  select array_agg(value) into v_categories from jsonb_array_elements_text(v_meta->'categories');

  insert into public.profiles (
    id, full_name, username, email, country, city, bio, experience, categories,
    university_id, academic_unit_id, specialty_id, specialty, faculty, avatar_url, created_at
  ) values (
    new.id, v_name, v_username, new.email, btrim(v_meta->>'country'),
    btrim(coalesce(v_meta->>'city', '')), btrim(coalesce(v_meta->>'bio', '')),
    v_meta->>'experience', v_categories, v_university, v_unit, v_specialty, v_program_name,
    v_faculty, '', new.created_at
  ) on conflict (id) do update set
    full_name = excluded.full_name, username = excluded.username, email = excluded.email,
    country = excluded.country, city = excluded.city, bio = excluded.bio,
    experience = excluded.experience, categories = excluded.categories,
    university_id = excluded.university_id, academic_unit_id = excluded.academic_unit_id,
    specialty_id = excluded.specialty_id, specialty = excluded.specialty,
    faculty = excluded.faculty;
  return new;
end;
$$;

revoke all on function public.xelay_create_registration_profile()
  from public, anon, authenticated;
drop trigger if exists xelay_registration_profile on auth.users;
create trigger xelay_registration_profile after insert on auth.users
  for each row execute function public.xelay_create_registration_profile();

commit;
