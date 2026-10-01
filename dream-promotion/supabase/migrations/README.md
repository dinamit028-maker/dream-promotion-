# Database migrations

Every database object the app uses is created by these files, in order. All of them are
idempotent (safe on the existing production project, nothing is deleted).

| File | What it does |
|---|---|
| `20261001000100_baseline.sql` | Original schema: profiles, brands, content, media, leads, ad_drafts, pronunciations, usage_events, the private `assets` bucket and its policies |
| `20261001000200_social_and_usage_tables.sql` | `social_accounts`, `social_posts`, `usage` — used by the app but previously missing from source control |
| `20261001000300_atomic_usage_reservation.sql` | Atomic quota reservation (`reserve_usage`, `commit_usage`, `release_usage`, `finish_usage`) + rate and concurrency limits |
| `20261001000400_storage_upload_limits.sql` | Size and type limits on the `assets` bucket |

Run them in Supabase → SQL Editor, one file at a time, in the order above
(or with the Supabase CLI: `supabase db push`).

`supabase/cron-stories.sql` is separate: it contains the cron secret, so it is run by hand
once per project and never committed with the real value.

`supabase/schema.sql` is kept for reference; the migrations are the source of truth.
| `20261001000500_ai_generations_ledger.sql` | `ai_generations` (every AI call and render: provider, model, units, estimated/actual cost, retries, fallbacks) + views `reel_costs` and `provider_health` |
| `20261001000600_scheduled_posts.sql` | `scheduled_posts` — posts planned for a time, with destinations and per-destination results (published by `/api/cron/publish-due`) |
