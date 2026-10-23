-- Read before and after the migration. No user identifiers or receipt content.
select c.conname, pg_get_constraintdef(c.oid) as definition
from pg_constraint c
where c.conrelid = 'public.account_announcement_receipts'::regclass
  and c.contype in ('c', 'p');

select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'account_announcement_receipts'
order by policyname;

select grantee, privilege_type, column_name
from information_schema.column_privileges
where table_schema = 'public' and table_name = 'account_announcement_receipts'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type, column_name;
