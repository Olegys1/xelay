-- Enable only after the new email template and both deadline migrations are
-- deployed, the email worker is healthy, and the expected volume is reviewed.
begin;
select cron.schedule('xelay-academic-deadline-reminders','*/10 * * * *',
  'select public.xelay_queue_academic_deadline_reminders();');
commit;
