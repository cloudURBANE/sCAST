-- AI-distilled review comments cache (see lib/db/src/schema/fragranceReviewSummaries.ts).
-- Without this table, /api/reviews/summarize calls Gemini on every wardrobe open.

create table if not exists public.fragrance_review_summaries (
  lookup_key text primary key,
  comments jsonb not null,
  source_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
