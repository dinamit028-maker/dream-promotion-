-- 2.112.0 — phone notifications of the calendar (tests/sql/appointment-alerts.check.sql). The owner of the system (31.10.2026):
--   "soon"      15 minutes before an appointment — to its practitioner (her account) and the business's owners: get the room ready;
--   "tomorrow"  at 10:00, the day before — to the same people: "מחר X תורים — לשלוח תזכורות", opening a list with a WhatsApp
--               message per customer, sent from their own WhatsApp (never from Dream's number — the rule of 5300).
-- appointment_alerts: each notification once (unique key per business — "soon:<appointment>:<user>", "tomorrow:<day>:<user>"),
-- claimed by the server before it is sent (/api/cron/commerce, every 2 minutes). The server's only: RLS on, no policy.
-- Additions only: no row changes.

create table if not exists public.appointment_alerts (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete cascade,
  dedupe_key  text not null check (length(dedupe_key) between 1 and 200),
  user_id     uuid not null references auth.users on delete cascade,
  sent_at     timestamptz not null default now(),
  devices     int not null default 0,
  unique (business_id, dedupe_key)
);
create index if not exists appointment_alerts_sent_idx on public.appointment_alerts (sent_at);
alter table public.appointment_alerts enable row level security;
revoke all on public.appointment_alerts from anon, authenticated;

-- ---- rollback (by hand, only to undo it) ---------------------------------------------------------------------------------------
--   drop table public.appointment_alerts;
