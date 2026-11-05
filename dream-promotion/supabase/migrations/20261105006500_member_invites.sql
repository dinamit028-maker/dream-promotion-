-- 2.114.0 — an invitation by link to a member of a business (tests/sql/member-invites.check.sql).
-- The owner of the system (05.11.2026): the super admin adds a person ("+ אדם") and sends them a link on WhatsApp; they tap it,
-- they are signed in, choose their own password (the phone saves it) — no password typed for them, no sign-up.
--   member_invites: one row per link. Only the sha-256 of the token is kept (the token is 64 hex, in the link only); 48 hours;
--   used once (used_at — a conditional update); a new link for the same person and business revokes the open ones.
--   The server's only: RLS on, no policy, no grant — the super admin's route writes it, the public /api/join/<token> reads it.
-- A new table only: no row of another table changes.

create table if not exists public.member_invites (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  access text not null check (access in ('full', 'register', 'calendar', 'agenda')),
  phone text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index if not exists member_invites_person on public.member_invites (business_id, user_id);

alter table public.member_invites enable row level security;
revoke all on table public.member_invites from public, anon, authenticated;
grant all on table public.member_invites to service_role;

-- ---- rollback (by hand, only to undo it) ---------------------------------------------------------------------------------------
--   the table is the server's only; dropping it (SQL Editor) stops the links — nothing else reads it.
