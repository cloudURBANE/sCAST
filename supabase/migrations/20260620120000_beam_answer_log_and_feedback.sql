-- Beam Agent: durable per-turn answer log + user feedback.
--
-- beam_answer_log persists one reproducible record per completed Beam answer
-- turn (id = the run id `run_<uuid>`), so a user report points at real data and
-- each downvote can become a regression fixture. beam_answer_feedback stores the
-- user's verdict tied to that log row. Additive; matches the Drizzle schema in
-- lib/db/src/schema/beamAnswerLog.ts + beamAnswerFeedback.ts.

create table if not exists public.beam_answer_log (
  id text primary key,
  tenant_id uuid references public.tenants(id),
  user_id uuid references public.users(id) on delete cascade,
  session_id text,
  user_message text not null,
  derived_state jsonb,
  lane text,
  orchestration_model text,
  synthesis_model text,
  grounded_candidates jsonb not null default '[]'::jsonb,
  final_answer text not null default '',
  gate_passed boolean not null default true,
  gate_violations jsonb not null default '[]'::jsonb,
  shipped_with_soft_violations boolean not null default false,
  outcome text,
  failure_code text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists beam_answer_log_user_created_idx
  on public.beam_answer_log (user_id, created_at);
create index if not exists beam_answer_log_created_at_idx
  on public.beam_answer_log (created_at);
create index if not exists beam_answer_log_expires_at_idx
  on public.beam_answer_log (expires_at);

create table if not exists public.beam_answer_feedback (
  id uuid primary key default gen_random_uuid(),
  answer_log_id text not null references public.beam_answer_log(id) on delete cascade,
  tenant_id uuid references public.tenants(id),
  user_id uuid references public.users(id) on delete set null,
  rating text not null default 'down',
  reason_code text,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists beam_answer_feedback_answer_log_idx
  on public.beam_answer_feedback (answer_log_id);
create index if not exists beam_answer_feedback_created_at_idx
  on public.beam_answer_feedback (created_at);
create index if not exists beam_answer_feedback_user_idx
  on public.beam_answer_feedback (user_id);
