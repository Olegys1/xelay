-- Classify the four verified KNU economics management programs by degree.
-- The catalog mixes levels; a valid master's program must not be deactivated
-- merely because it is not offered to bachelor students.
-- Official source: https://vstup.knu.ua/study-programs (checked 2026-10-16).
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regclass('public.academic_specialties') is null
    or to_regclass('public.universities') is null or to_regclass('public.academic_units') is null then
    raise exception 'Apply the university and academic specialties catalog migrations first';
  end if;
end $$;

alter table public.academic_specialties
  add column if not exists study_levels text[] not null default '{}'::text[];
alter table public.academic_specialties drop constraint if exists academic_specialties_study_levels_check;
alter table public.academic_specialties add constraint academic_specialties_study_levels_check check(
  study_levels <@ array['bachelor','master','postgraduate']::text[]
  and cardinality(study_levels)<=3
  and coalesce(array_ndims(study_levels),1)=1
  and array_position(study_levels,null) is null);

do $$ declare v_count integer; begin
  select count(*) into v_count
  from public.academic_specialties s
  join public.universities u on u.id=s.university_id
  join public.academic_units a on a.id=s.academic_unit_id and a.university_id=s.university_id
  where u.slug='knu' and a.slug='economics' and s.code='D3' and s.name in(
    'Бізнес-консалтинг','Менеджмент інноваційної діяльності',
    'Менеджмент організацій','Менеджмент підприємницької діяльності');
  if v_count<>4 then
    raise exception 'KNU_ECONOMICS_MANAGEMENT_CATALOG_SCOPE_MISMATCH: expected four exact catalog entries';
  end if;
end $$;

with expected(name,levels) as(values
  ('Бізнес-консалтинг',array['master']::text[]),
  ('Менеджмент інноваційної діяльності',array['master']::text[]),
  ('Менеджмент організацій',array['bachelor','master']::text[]),
  ('Менеджмент підприємницької діяльності',array['bachelor','master']::text[])
)
update public.academic_specialties s set study_levels=e.levels
from expected e,public.universities u,public.academic_units a
where s.university_id=u.id and a.id=s.academic_unit_id and a.university_id=u.id
  and u.slug='knu' and a.slug='economics' and s.code='D3' and s.name=e.name
  and s.study_levels is distinct from e.levels;

comment on column public.academic_specialties.study_levels is
  'Verified program degree levels. Empty array means not classified, not unavailable. No existing profile, group or request is reclassified by this metadata.';
notify pgrst,'reload schema';
commit;
