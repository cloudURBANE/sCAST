create index if not exists users_share_handle_idx
on public.users (
  (
    coalesce(
      nullif(
        regexp_replace(
          regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9]+', '-', 'g'),
          '(^-+|-+$)',
          '',
          'g'
        ),
        ''
      ),
      'user'
    )
  )
);

create index if not exists user_fragrances_user_id_idx
on public.user_fragrances (user_id);

create index if not exists user_fragrances_user_client_id_idx
on public.user_fragrances (user_id, ((fragrance_data->>'id')));
