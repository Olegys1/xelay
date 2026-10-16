-- READ-ONLY. Run before and after the metadata migration; output contains only
-- public catalog records and aggregate counts/hashes, no profile/contact data.
-- Legitimate concurrent profile/group/request changes can change an aggregate
-- hash. Do not infer a remapping requirement from that alone.
begin transaction isolation level repeatable read read only;

with catalog as (
  select s.*,u.slug as university_slug,a.slug as unit_slug
  from public.academic_specialties s
  join public.universities u on u.id=s.university_id
  join public.academic_units a on a.id=s.academic_unit_id and a.university_id=s.university_id
  where u.slug='knu' and a.slug='economics' and s.code='D3'
    and s.name in('Бізнес-консалтинг','Менеджмент інноваційної діяльності',
      'Менеджмент організацій','Менеджмент підприємницької діяльності')
)
select c.id,c.university_slug,c.unit_slug,c.code,c.name,c.is_active,c.source_url,
  -- Works before the column exists as well as after the migration.
  coalesce(to_jsonb(c)->'study_levels','[]'::jsonb) as study_levels,
  (select count(*) from public.profiles p where p.specialty_id=c.id) as profile_id_references,
  (select count(*) from public.profiles p where p.university_id=c.university_id and p.academic_unit_id=c.academic_unit_id
    and lower(btrim(p.specialty))=lower(btrim(c.name))) as profile_text_references,
  (select count(*) from public.study_groups g where g.university_id=c.university_id and g.academic_unit_id=c.academic_unit_id
    and lower(btrim(g.specialty))=lower(btrim(c.name))) as group_references,
  (select count(*) from public.class_representative_requests r where r.university_id=c.university_id and r.academic_unit_id=c.academic_unit_id
    and lower(btrim(r.specialty))=lower(btrim(c.name))) as request_references
from catalog c order by c.name;

select 'profiles' as relation,count(*) as row_count,
  md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' order by p.id::text),'')) as aggregate_row_hash
from public.profiles p
union all
select 'study_groups',count(*),md5(coalesce(string_agg(md5(to_jsonb(g)::text),'' order by g.id::text),''))
from public.study_groups g
union all
select 'class_representative_requests',count(*),md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' order by r.id::text),''))
from public.class_representative_requests r
order by relation;

rollback;
