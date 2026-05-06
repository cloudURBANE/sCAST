-- Scent Cast recovery seed helper
--
-- This file intentionally does not create users or wardrobe rows. For 1:1
-- continuity, restore those rows from the old dump.
--
-- Safe compatibility seed: create default share settings for any restored
-- app users missing settings rows.

insert into public.user_settings (user_id, share_hide_images)
select u.id, false
from public.users u
where not exists (
  select 1
  from public.user_settings s
  where s.user_id = u.id
);

