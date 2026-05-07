-- Safe fresh wipe of persisted image data.
--
-- This keeps the schema intact: no tables, columns, indexes, constraints, or
-- non-image fragrance/profile data are removed. It only clears cached image
-- metadata and app-level image references so the pipeline can repopulate them.

do $$
begin
  if to_regclass('public.image_cache') is not null then
    truncate table public.image_cache;
  end if;
end $$;

update public.global_fragrances
set profile_data = jsonb_set(
      coalesce(profile_data, '{}'::jsonb) - 'storagePath' - 'imageHash' - 'publicUrl',
      '{imageUrl}',
      '""'::jsonb,
      true
    ),
    updated_at = now()
where profile_data is not null
  and (
    coalesce(profile_data ->> 'imageUrl', '') <> ''
    or profile_data ? 'storagePath'
    or profile_data ? 'imageHash'
    or profile_data ? 'publicUrl'
  );

update public.user_fragrances
set fragrance_data = jsonb_set(
      coalesce(fragrance_data, '{}'::jsonb) - 'storagePath' - 'imageHash' - 'publicUrl',
      '{imageUrl}',
      '""'::jsonb,
      true
    )
where fragrance_data is not null
  and (
    coalesce(fragrance_data ->> 'imageUrl', '') <> ''
    or fragrance_data ? 'storagePath'
    or fragrance_data ? 'imageHash'
    or fragrance_data ? 'publicUrl'
  );
