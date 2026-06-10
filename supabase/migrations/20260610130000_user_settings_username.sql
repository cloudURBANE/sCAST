alter table public.user_settings
  add column if not exists username text;
