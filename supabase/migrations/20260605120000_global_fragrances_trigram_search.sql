create extension if not exists pg_trgm;

create index if not exists global_fragrances_search_trgm_idx
on public.global_fragrances
using gin (lower(brand || ' ' || name) gin_trgm_ops);

create index if not exists global_fragrances_lookup_key_trgm_idx
on public.global_fragrances
using gin (lower(lookup_key) gin_trgm_ops);

create index if not exists global_fragrances_brand_trgm_idx
on public.global_fragrances
using gin (lower(brand) gin_trgm_ops);
