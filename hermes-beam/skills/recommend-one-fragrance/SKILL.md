---
name: recommend-one-fragrance
description: Recommend the single best fragrance to wear from the user's vault for today / a given occasion and weather. Use for "what should I wear", "pick one for tonight", "best for this weather" style requests.
---

# Recommend one fragrance (from the vault)

Goal: one confident, well-justified pick the user already owns.

## Procedure

1. **Ground.** `beam_get_user_context` for vault + today's weather.
2. **Map the ask** to a destination (Staying In | Going Out | Work | Night Out | Date
   | Gym) and energy (Calm | Focused | Confident | Social | Relaxed). Infer from the
   message; ask only if genuinely ambiguous.
3. **Score deterministically.** Call `beam_score_candidates` with that
   destination/energy. Use its top pick, `score`, and `reason` — don't compute your own.
4. **Explain briefly.** One or two sentences: why this bottle suits the weather +
   occasion (cite the notes/accords from the packet). Optionally name the runner-up.

## Guardrails
- Recommend only from the vault (`beam_get_wardrobe` ids); this skill is about what
  they own.
- If the vault is empty, say so and offer to search the catalog instead.
- If weather is unavailable, note that the ranking used seasonal defaults.
