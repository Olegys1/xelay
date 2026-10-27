-- Prepared locally. Country is no longer collected by new Xelay forms.
-- Existing country values and privacy receipts are retained unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.academic_departments (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id),
  academic_unit_id uuid not null,
  slug text not null,
  name text not null check(length(btrim(name)) between 2 and 180),
  source_url text not null,
  is_active boolean not null default true,
  unique(academic_unit_id,slug),
  foreign key(academic_unit_id,university_id) references public.academic_units(id,university_id)
);
alter table public.academic_departments enable row level security;
revoke all on public.academic_departments from public,anon,authenticated,service_role;
comment on table public.academic_departments is 'Official department catalogue; seed maintained with source provenance. No client write access.';

with names(slug,name) as(values
  ('ecological-management','Кафедра екологічного менеджменту та підприємництва'),
  ('enterprise-economics','Кафедра економіки підприємства'),
  ('economic-cybernetics','Кафедра економічної кібернетики'),
  ('economic-theory','Кафедра економічної теорії, макро- і мікроекономіки'),
  ('marketing-business-administration','Кафедра маркетингу і бізнес-адміністрування'),
  ('innovation-investment-management','Кафедра менеджменту інноваційної та інвестиційної діяльності'),
  ('international-economics','Кафедра міжнародної економіки'),
  ('accounting-audit','Кафедра обліку та аудиту'),
  ('statistics-information-demography','Кафедра статистики, інформаційно-аналітичних систем і демографії'),
  ('insurance-banking-risk-management','Кафедра страхування, банківської справи та ризик-менеджменту'),
  ('finance','Кафедра фінансів'),
  ('foreign-languages','Кафедра іноземних мов')
)
insert into public.academic_departments(university_id,academic_unit_id,slug,name,source_url)
select u.id,f.id,n.slug,n.name,'https://econom.knu.ua/departments/' from names n
cross join public.universities u join public.academic_units f on f.university_id=u.id
where u.slug='knu' and f.slug='economics';

create function public.xelay_private_validate_department(p_department text,p_university_id uuid,p_unit_id uuid,p_preserved text default null)
returns text language plpgsql stable security definer set search_path='' as $$
declare v_name text:=btrim(coalesce(p_department,''));
begin
  if length(v_name) not between 2 and 180 then raise exception 'TEACHER_DEPARTMENT_INVALID' using errcode='22023'; end if;
  if exists(select 1 from public.academic_departments d where d.university_id=p_university_id and d.academic_unit_id=p_unit_id and d.is_active)
    and not exists(select 1 from public.academic_departments d where d.university_id=p_university_id and d.academic_unit_id=p_unit_id and d.is_active and d.name=v_name)
    and v_name is distinct from p_preserved then
    raise exception 'TEACHER_DEPARTMENT_INVALID' using errcode='22023';
  end if;
  return v_name;
end $$;
revoke all on function public.xelay_private_validate_department(text,uuid,uuid,text) from public,anon,authenticated,service_role;

-- Patch the current creator rather than replacing Google/consent/course guards.
do $$
declare v_body text;v_old text;v_new text;
begin
  select replace(pg_get_functiondef('public.xelay_create_registration_profile()'::regprocedure),chr(13),'') into v_body;
  v_old:='or length(btrim(coalesce(v_meta->>''country'', ''''))) not between 1 and 80';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'COUNTRYLESS_REGISTRATION_GUARD_DRIFT'; end if;
  v_body:=replace(v_body,v_old,'or length(btrim(coalesce(v_meta->>''country'', ''''))) > 80 -- countryless_registration_contract: legacy optional input');
  v_old:='new.id, v_name, v_username, new.email, btrim(v_meta->>''country''),';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'COUNTRYLESS_REGISTRATION_INSERT_DRIFT'; end if;
  v_body:=replace(v_body,v_old,'new.id, v_name, v_username, new.email, coalesce(btrim(v_meta->>''country''),''''),');
  v_old:='if coalesce(v_teacher,false) then';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'DEPARTMENT_REGISTRATION_SCOPE_DRIFT'; end if;
  v_new:=$patch$if coalesce(v_teacher,false) then
    perform public.xelay_private_validate_department(v_meta->>'teacher_department',v_university,v_unit);
  $patch$;
  execute replace(v_body,v_old,v_new);
end $$;

-- Both email and Google use the patched creator. Old clients may still submit
-- a country; new clients omit it, and no location is inferred from provider/IP.
notify pgrst,'reload schema';
commit;
