# Search Result Display Bugs — Diagnosis & Fix Plan

**Date:** 2026-05-26  
**Observed on:** scentbeam.com / FragranceCapture component  
**Screenshots:** Two iPad screenshots showing garbled result and irrelevant single-char match

---

## Bug 1 — Garbled result name: "and gabana Q / DOLCE"

### What was observed
User searched **"Dolce and gabana Q"** (note: single-b "gabana", user's spelling).  
The search result card showed:

```
name:  and gabana Q
house: DOLCE
```

The actual fragrance is **Q by Dolce & Gabbana** and should display as `Q / DOLCE GABBANA`.

---

### Root-cause chain

#### Layer 1 — Query text leaks into stored fragrance name (primary cause)

File: `search_engine/api.py` — `_persist_search_results()` → `_recover_candidate_identity()`

When a live scrape produces a result card where the fragrance name is missing or garbage, the engine falls back to deriving the name from whatever text was available — sometimes the Google snippet title, which mirrors the user's exact query string ("Dolce and gabana Q"). This is stored verbatim into `fragrance_records` via `db.upsert_fragrance_search()`.

Because the value is stored with the user's misspelling ("gabana", one-b), subsequent DB searches using `ILIKE '%Dolce and gabana Q%'` hit `concat_ws(' ', 'Dolce', 'and gabana Q')` — an exact match on the poisoned row.

Proof: The letter sequence "gabana" (one-b) cannot originate from Fragrantica's canonical data. Its presence in the result name proves the Google snippet / user query was reflected back as a "name".

#### Layer 2 — `strip_house_from_name` over-strips partial brand prefix

File: `search_engine/fragrance_parser_full_rewrite_fixed.py` — `IdentityTools.strip_house_from_name()`

The poisoned record has `name = "Dolce and gabana Q"`, `house = "Dolce"`. During `_recover_candidate_identity`:

1. `brand_forms("Dolce")` returns `{"dolce"}` — no alias hit because `BRAND_ALIASES` has `"dolce and gabbana"` as a key but **"dolce" alone is not a listed alias for it**.
2. `normalize_identity("Dolce and gabana Q")` → `"dolce and gabana q"` (& → "and" per `normalize_identity` line 417; accents stripped).
3. `"dolce and gabana q".startswith("dolce ")` → `True`.
4. The function strips the leading "Dolce" token → remainder = `"and gabana Q"`.
5. No guard exists to reject a remainder that begins with a conjunction ("and").

**Result:** name = `"and gabana Q"`, house = `"Dolce"` → displayed exactly as seen.

#### Layer 3 — BRAND_ALIASES gap: "dolce gabbana" (URL form) ≠ "dolce and gabbana" (alias key)

`brand_from_url("https://fragrantica.com/perfume/Dolce-Gabbana/...")` returns `"Dolce Gabbana"` (hyphen → space). `normalize_identity("Dolce Gabbana")` = `"dolce gabbana"`. But `BRAND_ALIASES` only contains `"dolce and gabbana"` as a key — there is no alias `"dolce gabbana"` mapping to it. So `brand_forms("Dolce Gabbana")` = `{"dolce gabbana"}` with no expanded forms, and `strip_house_from_name` cannot correctly identify the full brand to strip.

---

### Fix plan for Bug 1

**Fix 1A — `strip_house_from_name`: reject conjunction-prefixed remainders**  
File: `search_engine/fragrance_parser_full_rewrite_fixed.py`, inside `strip_house_from_name()` before each `return remainder`:

```python
_CONJUNCTION_STARTERS = frozenset({"and", "by", "de", "du", "di", "et", "van", "von"})

# Guard: if the remainder starts with a known conjunction, the strip was wrong.
first_remainder_word = remainder.split()[0].lower() if remainder.split() else ""
if first_remainder_word in _CONJUNCTION_STARTERS:
    continue  # don't strip; try next form or fall through to return cleaned_name
```

This single guard would have prevented "and gabana Q" from ever being returned.

**Fix 1B — Expand `BRAND_ALIASES` to cover URL-derived form**  
File: `search_engine/fragrance_parser_full_rewrite_fixed.py`, `IdentityTools.BRAND_ALIASES`:

```python
# Current:
"dolce and gabbana": {"dolce and gabbana", "d and g", "dg"},

# Change to:
"dolce and gabbana": {"dolce and gabbana", "dolce gabbana", "d and g", "dg"},
```

This ensures `brand_forms("Dolce Gabbana")` (URL-derived form) correctly identifies the house as "Dolce Gabbana" / "Dolce and Gabbana" and strips the full prefix from names like "Dolce Gabbana Q" → "Q".

Do NOT add bare `"dolce"` as an alias — there are other brands with "dolce" in the name (e.g., "Dolce Vita" by Dior).

**Fix 1C — Guard `_persist_search_results` against conjunction-prefixed names**  
File: `search_engine/api.py`, `_persist_search_results()`:

```python
_BAD_NAME_STARTERS = frozenset({"and", "by", "de", "du", "di", "et", "&"})

def _name_looks_valid(name: str) -> bool:
    tokens = name.strip().split()
    if not tokens:
        return False
    return tokens[0].lower() not in _BAD_NAME_STARTERS

# In _persist_search_results, before upsert_fragrance_search:
if not _name_looks_valid(identity["name"] or item.name):
    continue  # skip persisting this poisoned row
```

This prevents future poisoning of `fragrance_records`.

**Fix 1D — (Optional, belt-and-suspenders) Clean existing poisoned rows**  
Run a one-off SQL against `fragrance_records`:

```sql
DELETE FROM fragrance_records
WHERE name ~ '^(and|by|de|du|di|et|&)\s'
   OR house IN ('', 'Unknown', 'unknown');
```

---

## Bug 2 — Single-char "Q" returns "Acqua Di Gio Pour Homme"

### What was observed
User had only **"Q"** in the search field.  
The result showed:

```
name:  Acqua Di Gio Pour Homme
house: GIORGIO ARMANI
```

"Q" should match "Q by Dolce & Gabbana", not "Acqua Di Gio".

---

### Root-cause chain

#### Layer 1 — `relevance_score` uses substring `in` on the full target string (critical bug)

File: `search_engine/fragrance_parser_full_rewrite_fixed.py`, `IdentityTools.relevance_score()`, lines ~799–805:

```python
for qt in q_tokens:
    if qt in target_words or qt in target_full:   # ← BUG HERE
        matched_score += 1.0
```

- `qt in target_words` — correct: tests list membership (is "q" equal to any word?).
- `qt in target_full` — **wrong**: Python `in` on a string is a **substring check**, not a word check.

For query `"q"` and target `"giorgio armani acqua di gio pour homme"`:
- `"q" in ["giorgio", "armani", "acqua", ...]` → `False` ✓
- `"q" in "giorgio armani acqua di gio pour homme"` → `True` ✗ (the letter "q" appears inside "acqua")

So `matched_score = 1.0`, `token_confidence = 1.0 / 1 = 1.0` — a **perfect relevance score** for a completely wrong match.

This bug affects every query whose text appears as a substring anywhere in any fragrance name, but is most damaging for short queries (single characters) since they appear inside common words.

#### Layer 2 — DB `ILIKE '%Q%'` returns false positives for single characters

File: `search_engine/db.py`, `search_fragrance_records()` and `search_detail_cache()`:

```python
like = f"%{text}%"
# ...
WHERE name ILIKE %s   -- '%Q%' matches "Acqua" because "Q" ⊂ "Acqua"
```

No minimum token length guard. A one-character query produces `ILIKE '%Q%'` which matches any word containing that letter, returning dozens of false-positive rows before `relevance_score` is applied.

---

### Fix plan for Bug 2

**Fix 2A — Fix `relevance_score` substring bug**  
File: `search_engine/fragrance_parser_full_rewrite_fixed.py`, `IdentityTools.relevance_score()`:

```python
# Current (buggy):
for qt in q_tokens:
    if qt in target_words or qt in target_full:
        matched_score += 1.0
    else:
        best_word_match = max([SequenceMatcher(None, qt, t_word).ratio() for t_word in target_words] + [0.0])
        matched_score += best_word_match

# Fixed:
_MIN_FUZZY_TOKEN_LEN = 3  # tokens shorter than this use exact-word matching only

for qt in q_tokens:
    if qt in target_words:
        matched_score += 1.0
    elif len(qt) >= _MIN_FUZZY_TOKEN_LEN:
        best_word_match = max(
            [SequenceMatcher(None, qt, t_word).ratio() for t_word in target_words] + [0.0]
        )
        matched_score += best_word_match
    # else: short token not found as exact word → 0 contribution
```

Drop `qt in target_full` entirely. Short tokens (≤ 2 chars) only get credit for exact word matches.

**Fix 2B — DB queries: add minimum length guard**  
File: `search_engine/db.py`, `search_fragrance_records()` and `search_detail_cache()`:

```python
# Current:
like = f"%{text}%"

# Add a word-boundary variant for short queries:
if len(text) <= 2:
    # Pad with spaces so "Q" only matches word-boundary "Q", not "AcQua"
    like = f"% {text} %"   # matches " Q " — word surrounded by spaces
    # Also match at start/end of the concatenated value:
    like_start = f"{text} %"
    like_end = f"% {text}"
    # Use: concat_ws(' ', ' ' || house || ' ', ' ' || name || ' ') ILIKE '% Q %'
```

Or alternatively, require `len(text) >= 2` before running ILIKE at all (single-char queries skip DB and go straight to live search).

**Fix 2C — (Design improvement) Handle single-char fragrance names**  
Fragrances named with single letters ("Q", "L", "M", "N", "J") are real. Instead of a blanket short-query block, the proper fix is:
1. Fix 2A (exact word matching in `relevance_score`) — this is sufficient to prevent "Q" scoring 1.0 against "Acqua".
2. Allow DB searches for short queries using padded ILIKE (Fix 2B) so real single-letter fragrances are found.

---

## Files to change (summary)

| File | Function | Change |
|------|----------|--------|
| `search_engine/fragrance_parser_full_rewrite_fixed.py` | `IdentityTools.strip_house_from_name()` | Reject remainder that starts with conjunction (Fix 1A) |
| `search_engine/fragrance_parser_full_rewrite_fixed.py` | `IdentityTools.BRAND_ALIASES` | Add `"dolce gabbana"` to D&G alias set (Fix 1B) |
| `search_engine/fragrance_parser_full_rewrite_fixed.py` | `IdentityTools.relevance_score()` | Remove `qt in target_full` substring check; add length guard (Fix 2A) |
| `search_engine/api.py` | `_persist_search_results()` | Guard against storing conjunction-prefixed names (Fix 1C) |
| `search_engine/db.py` | `search_fragrance_records()` + `search_detail_cache()` | Padded ILIKE or minimum length guard for short queries (Fix 2B) |

---

## Verification steps for the implementing agent

1. **Unit-test `strip_house_from_name`** with:
   - `("Dolce and gabana Q", "Dolce")` → must return `"Dolce and gabana Q"` (not stripped, because remainder "and gabana Q" starts with "and")
   - `("Dolce & Gabbana Q", "Dolce & Gabbana")` → must return `"Q"`
   - `("Dolce Gabbana Q", "Dolce Gabbana")` → must return `"Q"` (after Fix 1B adds "dolce gabbana" alias)
   - `("Hermès Rocabar", "Hermès")` → must return `"Rocabar"` (existing correct behavior preserved)

2. **Unit-test `relevance_score`** with:
   - `("q", UnifiedFragrance(name="Q", brand="Dolce Gabbana", ...))` → score near 1.0
   - `("q", UnifiedFragrance(name="Acqua Di Gio Pour Homme", brand="Giorgio Armani", ...))` → score < 0.4
   - `("dolce and gabbana q", UnifiedFragrance(name="Q", brand="Dolce Gabbana", ...))` → score > 0.85

3. **Manual search test on Railway** after deploy:
   - Search "Q" → should return "Q" by D&G as top result, NOT Acqua Di Gio
   - Search "Dolce & Gabbana Q" → should return `"Q / DOLCE GABBANA"` (not "and Gabbana Q / DOLCE")
   - Search "Dolce and gabana Q" → same as above (fuzzy match should still find it)

4. **Check for existing poisoned rows** in `fragrance_records`:
   ```sql
   SELECT id, name, house FROM fragrance_records
   WHERE name ~ '^(and|by|de|&)\s'
   LIMIT 20;
   ```
   Delete any rows found.

---

## Risk notes

- Fix 1A (conjunction guard in `strip_house_from_name`) is low-risk — no real fragrance name legitimately starts with "and".
- Fix 1B (BRAND_ALIASES expansion) is low-risk for "dolce gabbana" — verify no other brand normalizes to this string.
- Fix 2A (remove `qt in target_full`) could reduce recall for very short tokens that are meaningful substrings of words (e.g., "oud" inside "Oud Wood"). However, `oud` is 3 chars, which meets the `_MIN_FUZZY_TOKEN_LEN = 3` threshold and will still go through the SequenceMatcher path. Tokens ≤ 2 chars that aren't exact word matches will score 0 — this is the correct behavior.
- Fix 2B (padded ILIKE) must be tested to ensure single-letter fragrance names ("Q", "L") are still returned from DB. The padded form `"% Q %"` works when the DB value is `"dolce gabbana q"` because the letter appears as a trailing word (`"gabbana q"` ends with `" q"`). Use `LIKE '% Q'` OR `LIKE '% Q %'` OR `LIKE 'Q %'` OR exact match `= 'Q'` to cover all word-boundary positions.
