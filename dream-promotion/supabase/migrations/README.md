# Database migrations

**Status (2026-10-05): every migration up to 3200 has run on the live database** — 1600 to 3200 appear in Supabase's migration list; 100 to 1500 were run by hand in the SQL Editor earlier (their tables exist).
**3200 (`20261005003200_pilot_hardening.sql`) was applied on 2026-10-05 after the owner's explicit approval** (live name `20261005171502`). Read-only checks afterwards: its functions, policies, triggers and grants are identical to the tested local database; no data changed. See "מצב מיגרציות" in STATUS.md.

Every database object the app uses is created by these files, in order. All of them are
idempotent (safe on the existing production project, nothing is deleted).

| File | What it does |
|---|---|
| `20261001000100_baseline.sql` | Original schema: profiles, brands, content, media, leads, ad_drafts, pronunciations, usage_events, the private `assets` bucket and its policies |
| `20261001000200_social_and_usage_tables.sql` | `social_accounts`, `social_posts`, `usage` — used by the app but previously missing from source control |
| `20261001000300_atomic_usage_reservation.sql` | Atomic quota reservation (`reserve_usage`, `commit_usage`, `release_usage`, `finish_usage`) + rate and concurrency limits |
| `20261001000400_storage_upload_limits.sql` | Size and type limits on the `assets` bucket |

| `20261001000500_ai_generations_ledger.sql` | `ai_generations` (every AI call and render: provider, model, units, estimated/actual cost, retries, fallbacks) + views `reel_costs` and `provider_health` |
| `20261001000600_scheduled_posts.sql` | `scheduled_posts` — posts planned for a time, with destinations and per-destination results (published by `/api/cron/publish-due`) |
| `20261002000700_transcribe_quota.sql` | `usage.kind` accepts `transcribe`, `text`, `render` — every paid endpoint is reserved and counted |
| `20261002000800_reel_column_media_meta.sql` | `content.reel` (reel projects — was only in production) and `media.meta` (source of imported files) |
| `20261002000900_crm.sql` | CRM: leads gets email, tags, value, last contact, next follow-up; `lead_activities` timeline (RLS: own rows) |
| `20261003001000_booking.sql` | Booking: `booking_settings` (slug, hours, rules), `booking_services`, `appointments` with a no-overlap constraint (btree_gist) |
| `20261003001100_timeclock.sql` | Time clock: `employees` (private clock link token, hourly rate), `time_entries` (one open shift per employee) |
| `20261003001200_register.sql` | Register: `register_settings` (exempt/licensed, VAT, payment link), `catalog_items` (price list), `sales` (records, not tax documents) |
| `20261003001300_timeclock_qr.sql` | Time clock by QR: `timeclock_settings` (site code, require scan, optional location lock); entries may be `source='qr'` |
| `20261003001400_documents.sql` | Legal documents: gap-free numbering per type (locked counter), immutable after issue (trigger), server issue time, print counter (מקור / העתק); legal business details in `register_settings` |
| `20261003001500_pos.sql` | POS: catalog categories (package/other), favorites + order, optional image; sales split payments + employee attribution |
| `20261003001600_pos_extras.sql` | Register extras: cash received / change, document share link token (set at issue), push subscriptions for sale notifications |
| `20261003001700_security_hardening.sql` | Security: fixed search_path on trigger functions; trigger functions not callable via the API (already applied to production) |
| `20261003001800_register_shifts.sql` | Register close of day: `register_shifts` (opening cash, counted / expected cash, difference, note, who); one open day per business; RLS own rows |
| `20261004001900_businesses.sql` | Multi-business stage 1: `businesses` (status, paid_until, grace_days), `business_members` (owner/editor/viewer), `profiles.is_super_admin` (API cannot change it — trigger), `meta_connections` (one Meta connection per Facebook user; tokens server-only). RLS on, no client policies until stage 4 |
| `20261004002000_business_id.sql` | Multi-business stage 2: `business_id` on 23 tables (+ `profiles.current_business_id`); trigger `a_fill_business_id` fills it from the creator's business so the app keeps working; one settings row per business; document numbering per business; issued documents may only get their business attached once |
| `20261004002100_business_id_required.sql` | Multi-business stage 2b: `business_id NOT NULL` everywhere except `ai_generations` (cost ledger). Run after the backfill (fails loudly if any row has no business) |
| `20261004002200_social_assets.sql` | Multi-business stage 3: `social_accounts.connection_id` / `status` (active/missing) / `missing_since`; an asset may be unassigned (business_id null, no auto-fill); one row per asset `unique (provider, external_id)`; `social_accounts_public` view and column grants — tokens are never readable from the browser |
| `20261004002300_business_rls.sql` | Multi-business stage 4: `is_super_admin()`, `business_is_active()`, `can_access_business()`, `accessible_business_ids()`; a restrictive gate + member policy on the 23 business tables; quotas guarded |
| `20261004002400_scheduled_cancel_reason.sql` | Multi-business stage 5: `scheduled_posts.cancel_reason` ("העסק נעול") |
| `20261004002500_current_business.sql` | Multi-business stage 7: `current_business_id()`; the gates show only the business being worked in; no overlapping appointments per business |
| `20261004002600_business_keys.sql` | Multi-business stage 7: one-per-business primary keys, document numbering per business (applied live) |
| `20261004002700_meta_leads.sql` | Meta Lead Ads → CRM: `social_accounts.leads_enabled`, `leads.external_source/external_id` (unique per business), `meta_lead_sync` (RLS via `can_access_business`) |
| `20261004002800_social_inbox.sql` | Comments and messages → CRM: `social_messages` (every comment / message, in and out, per business), `meta_inbox_sync`, `social_accounts.inbox_enabled` (applied live) |
| `20261004002900_social_messages_post_image.sql` | `social_messages.post_image` — a stored copy of the post's picture (applied live as `20261004182752`) |
| `20261004003000_register_pro.sql` | Register 2.50: `sale_refunds`, `stock_movements`, stock / commission columns, business billing details, `business_members.access` ('full' / 'register'), `my_access()`, `adjust_stock()`, cashier RESTRICTIVE policies (applied live as `20261004201025`) |
| `20261004003100_dream_finance.sql` | **Dream Finance 2.51 — applied live on 2026-10-05 after explicit approval (live name `20261005055117`); verified identical to the tested schema (184 objects).** Finance profile, drafts, cancellations, quotes, expenses, payments ledger, allocation rules / requests, Tax Authority connections (server only), hash-chained audit log, super-admin access grants, period locks, `receivables` view, `finance_summary()`, `finance-files` bucket; 9 new columns on `documents`; RESTRICTIVE `_finance_privacy` also on documents / document_counters / sales / refunds / shifts (14 in all). Additions only, no drop. Before / after checks: `docs/finance-security-review.md` §5 |
| `20261005003200_pilot_hardening.sql` | **2.52.1 — applied live on 2026-10-05 after explicit approval (live name `20261005171502`); verified identical to the tested schema (12 functions, 105 policies, 8 triggers, 42 grants).** `a_gate_caller` on documents / sale_refunds / document_cancellations / quotes / expenses / document_drafts (no error message tells one business another's numbers); `business_for_user` / `business_is_active` server only; `finance_locked_until` only for a business whose money the caller sees; no self-membership from the browser + `business_members_audit`; `profiles.email` not writable by users; `can_write()` + `_viewer_insert/_update/_delete` on every business table (viewer = read only) and in the write RPCs; `d_documents_checks` (a receipt never above the invoice's balance; 400 pays 300 only without VAT; lines / payments content); a register refund and a credit refund together never above the sale; TRUNCATE revoked from anon / authenticated. Checks after applying (done): `TESTING.md` §19 |

**Note on live names:** migrations applied through the Supabase MCP get a timestamp of the moment they were applied (e.g. `20261004201025` for `register_pro`), not the file's name. `list_migrations` shows the live names.

Run them in Supabase → SQL Editor, one file at a time, in the order above
(or with the Supabase CLI: `supabase db push`).

`supabase/cron-stories.sql` is separate: it contains the cron secret, so it is run by hand
once per project and never committed with the real value.

`supabase/schema.sql` is kept for reference; the migrations are the source of truth.
