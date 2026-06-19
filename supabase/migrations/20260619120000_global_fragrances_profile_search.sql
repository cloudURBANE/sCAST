-- Indexed descriptive (profile) retrieval for Beam catalog search.
--
-- Beam's descriptive search (`searchCatalogProfileCandidates`) filters the
-- catalog by how users describe scents — notes, accords, family, pyramid,
-- context, description — using
--   lower((profile_data - 'scent_vector')::text) LIKE '%term%'.
-- With no matching index that is a sequential scan over global_fragrances,
-- bounded in code to 96 candidate rows. As the catalog grows the scan, not the
-- bound, becomes the bottleneck (BEAM_AGENT_LOGIC_AUDIT.md follow-up #1).
--
-- A GIN trigram index on the *exact* filter expression makes those substring
-- LIKE probes index-accelerated. Trigram is deliberately chosen over a
-- tsvector/@@ index here: the search terms substring-match compound notes
-- ("wood" -> "sandalwood"/"rosewood", "moss" -> "oakmoss") that a tsvector
-- lexeme/prefix query would silently miss, which would change retrieval
-- behavior. This mirrors the existing global_fragrances_search_trgm_idx
-- convention (20260605120000_global_fragrances_trigram_search.sql) and is a
-- safe additive change: if the index is absent the same query still runs as a
-- (slower) sequential scan, so retrieval never breaks.
--
-- The index expression must match the query expression character-for-character
-- for the planner to use it; keep them in sync with searchCatalogProfileCandidates.

create extension if not exists pg_trgm;

create index if not exists global_fragrances_profile_trgm_idx
on public.global_fragrances
using gin (lower((profile_data - 'scent_vector')::text) gin_trgm_ops);
