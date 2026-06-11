alter table public.user_settings
  add column if not exists weather_latitude double precision;

alter table public.user_settings
  add column if not exists weather_longitude double precision;

alter table public.user_settings
  add column if not exists weather_location_label text;

alter table public.user_settings
  add column if not exists weather_location_updated_at timestamp without time zone;
