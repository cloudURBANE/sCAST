-- Durable onboarding progress on user_settings.
--
-- Separates "this user already completed the add-3 onboarding" from the live
-- wardrobe item count, so a slow / empty / 401 /api/wardrobe response can no
-- longer flash the add-3 prompt at a user who already finished it.

alter table public.user_settings
  add column if not exists wardrobe_onboarding_completed boolean not null default false;

alter table public.user_settings
  add column if not exists wardrobe_onboarding_completed_at timestamp without time zone;

-- Backfill: anyone who already holds >= 3 wardrobe rows has demonstrably
-- completed onboarding. Create the settings row when it does not exist yet.
insert into public.user_settings (user_id, tenant_id, wardrobe_onboarding_completed, wardrobe_onboarding_completed_at)
select uf.user_id, u.tenant_id, true, now()
from public.user_fragrances uf
join public.users u
  on u.id = uf.user_id
 and u.tenant_id = uf.tenant_id
group by uf.user_id, u.tenant_id
having count(*) >= 3
on conflict (user_id) do update
  set wardrobe_onboarding_completed = true,
      wardrobe_onboarding_completed_at = coalesce(public.user_settings.wardrobe_onboarding_completed_at, now()),
      updated_at = now();
