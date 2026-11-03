-- Enable only after the academic notification migrations and email code are
-- deployed, the email worker is healthy, and the expected volume is reviewed.
begin;
select cron.schedule('xelay-academic-deadline-reminders','*/10 * * * *',
  'select public.xelay_queue_academic_deadline_reminders();');
select cron.schedule('xelay-teaching-followups','*/10 * * * *',
  'select public.xelay_queue_teaching_followups();');
commit;
