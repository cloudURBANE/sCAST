create table if not exists public.affiliate_links (
  id uuid primary key default gen_random_uuid(),
  fragrance_id uuid not null references public.user_fragrances(id) on delete cascade,
  provider text not null default 'cj',
  advertiser_id text,
  advertiser_name text,
  product_title text,
  product_brand text,
  destination_url text,
  affiliate_url text not null,
  image_url text,
  price numeric,
  currency text,
  match_score real,
  status text not null default 'active',
  fetched_at timestamp without time zone,
  last_verified_at timestamp without time zone,
  click_count integer not null default 0,
  created_at timestamp without time zone not null default now(),
  updated_at timestamp without time zone not null default now()
);

create index if not exists affiliate_links_fragrance_provider_idx
on public.affiliate_links (fragrance_id, provider);

create index if not exists affiliate_links_status_idx
on public.affiliate_links (status);

comment on table public.affiliate_links is
  'Cached affiliate buy links for wardrobe fragrances and public share cards.';
