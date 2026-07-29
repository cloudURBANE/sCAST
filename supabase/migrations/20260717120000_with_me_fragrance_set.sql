ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS with_me_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS with_me_updated_at timestamp without time zone;

CREATE TABLE IF NOT EXISTS public.user_fragrance_with_me (
  user_fragrance_id uuid PRIMARY KEY
    REFERENCES public.user_fragrances(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES public.tenants(id),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamp without time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_fragrance_with_me_tenant_user_idx
  ON public.user_fragrance_with_me (tenant_id, user_id);

