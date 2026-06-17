-- Required by GET /api/wardrobe's conditional-request version query.
-- Existing rows are backfilled by the default when the column is added.
alter table public.user_fragrances
  add column if not exists updated_at timestamp without time zone not null default now();
