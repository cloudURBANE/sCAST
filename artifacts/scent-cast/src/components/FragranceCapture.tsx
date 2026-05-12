import React, { useState, useRef, useEffect, useReducer } from 'react';
import { Search, RefreshCw, Check, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BottleImage } from '@/components/BottleImage';

/**
 * Generate a stable, collision-resistant id for newly added wardrobe items.
 * `Math.random().toString(36).substr(2, 9)` is 9 alphanumeric chars (~52
 * bits) — small enough that real users hit collisions, which then make
 * `data.id`-keyed lookups in the wardrobe PATCH/DELETE routes ambiguous (B8).
 */
function newFragranceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for very old browsers — full 128-bit space, hex.
  const a = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const b = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const c = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const d = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${a}-${b}-${c}-${d}`;
}

async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.clone().json();
    if (typeof data?.error === 'string' && data.error.trim()) return data.error;
    if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  } catch {
    try {
      const text = await res.text();
      if (text.trim()) return text.trim();
    } catch {
      /* fall through to fallback */
    }
  }
  return fallback;
}

type FragranceMatch = {
  name: string;
  brand: string;
  imageUrl: string;
  notes?: string[];
  family?: string;
  description?: string;
  pyramid?: unknown;
  perfumer?: string;
  scent_vector?: unknown;
  selectedIdentity?: BaseNotesIdentity;
} & Record<string, unknown>;

type BaseNotesNoteGroups = { top: string[]; heart: string[]; base: string[] };
type BaseNotesNotes =
  | { parsed: false }
  | { parsed: true; grouped?: BaseNotesNoteGroups; flat?: string[] };

type BaseNotesCandidate = {
  brand: string;
  name: string;
  year?: string;
  url: string;
  searchLabel: string;
};

type BaseNotesDetail = BaseNotesCandidate & {
  perfumer?: string;
  notes: BaseNotesNotes;
};

type BaseNotesIdentity = {
  brand: string;
  name: string;
  year?: string;
  url: string;
  searchLabel: string;
};

type ConcentrationHint = 'any' | 'edt' | 'edp' | 'parfum' | 'extrait' | 'elixir';

const QUICK_SEARCH_TAGS = ['Aventus', 'Rouge 540', 'Santal 33'];
const CONCENTRATION_OPTIONS: { id: ConcentrationHint; label: string }[] = [
  { id: 'any', label: 'Any' },
  { id: 'edt', label: 'EDT' },
  { id: 'edp', label: 'EDP' },
  { id: 'parfum', label: 'Parfum' },
  { id: 'extrait', label: 'Extrait' },
  { id: 'elixir', label: 'Elixir' },
];

/**
 * Explicit phases for the BaseNotes-augmented capture flow.
 *
 * Why a state machine: the previous single-step search left several
 * race conditions implicit. With BaseNotes layered in, each transition
 * needs to atomically reset stale data (candidates, detail, profile,
 * errors) so a slow request from a previous search can never overwrite
 * the active selection.
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'searching_candidates'; query: string }
  | {
      kind: 'showing_candidates';
      query: string;
      candidates: BaseNotesCandidate[];
      selectedIdx: number | null;
      selectionLocked: boolean;
      candidateError: string | null;
    }
  | {
      kind: 'fetching_detail';
      query: string;
      candidates: BaseNotesCandidate[];
      selectedIdx: number;
    }
  | {
      kind: 'fetching_profile';
      query: string;
      candidates: BaseNotesCandidate[];
      selectedIdx: number;
      identity: BaseNotesDetail;
    }
  | {
      kind: 'complete';
      query: string;
      profile: FragranceMatch;
      identity: BaseNotesDetail | null;
      basenotesUnavailable: boolean;
    }
  | { kind: 'error'; message: string };

type Action =
  | { type: 'reset' }
  | { type: 'startSearch'; query: string }
  | {
      type: 'candidatesLoaded';
      query: string;
      candidates: BaseNotesCandidate[];
    }
  | {
      type: 'candidateSearchFailed';
      query: string;
      message: string;
    }
  | {
      type: 'selectCandidate';
      query: string;
      candidates: BaseNotesCandidate[];
      idx: number;
    }
  | {
      type: 'detailLoaded';
      query: string;
      candidates: BaseNotesCandidate[];
      selectedIdx: number;
      detail: BaseNotesDetail;
    }
  | {
      type: 'detailFailed';
      query: string;
      candidates: BaseNotesCandidate[];
      selectedIdx: number;
      message: string;
    }
  | {
      type: 'profileLoaded';
      query: string;
      profile: FragranceMatch;
      identity: BaseNotesDetail | null;
      basenotesUnavailable: boolean;
    }
  | {
      type: 'profileFailed';
      message: string;
    };

function reducer(_state: Phase, action: Action): Phase {
  switch (action.type) {
    case 'reset':
      return { kind: 'idle' };
    case 'startSearch':
      return { kind: 'searching_candidates', query: action.query };
    case 'candidatesLoaded':
      return {
        kind: 'showing_candidates',
        query: action.query,
        candidates: action.candidates,
        selectedIdx: null,
        selectionLocked: false,
        candidateError: null,
      };
    case 'candidateSearchFailed':
      return {
        kind: 'showing_candidates',
        query: action.query,
        candidates: [],
        selectedIdx: null,
        selectionLocked: false,
        candidateError: action.message,
      };
    case 'selectCandidate':
      return {
        kind: 'fetching_detail',
        query: action.query,
        candidates: action.candidates,
        selectedIdx: action.idx,
      };
    case 'detailLoaded':
      return {
        kind: 'fetching_profile',
        query: action.query,
        candidates: action.candidates,
        selectedIdx: action.selectedIdx,
        identity: action.detail,
      };
    case 'detailFailed':
      return {
        kind: 'showing_candidates',
        query: action.query,
        candidates: action.candidates,
        selectedIdx: action.selectedIdx,
        selectionLocked: false,
        candidateError: action.message,
      };
    case 'profileLoaded':
      return {
        kind: 'complete',
        query: action.query,
        profile: action.profile,
        identity: action.identity,
        basenotesUnavailable: action.basenotesUnavailable,
      };
    case 'profileFailed':
      return { kind: 'error', message: action.message };
    default:
      return _state;
  }
}

export const FragranceCapture: React.FC<{ onAdd?: (item: any) => void }> = ({ onAdd }) => {
  const [phase, dispatch] = useReducer(reducer, { kind: 'idle' });
  const [searchQuery, setSearchQuery] = useState('');
  const [concentrationHint, setConcentrationHint] = useState<ConcentrationHint>('any');
  const [statusLine, setStatusLine] = useState('');
  const [syncing, setSyncing] = useState(false);

  // One generation per kicked-off search; stale callbacks check this before
  // mutating phase, preventing a slow first request from overwriting a fresh one.
  const generationRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const profileAbortRef = useRef<AbortController | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      profileAbortRef.current?.abort();
      syncAbortRef.current?.abort();
    };
  }, []);

  const aborted = (err: unknown) =>
    err instanceof DOMException && err.name === 'AbortError';

  const beginNewSearch = () => {
    generationRef.current += 1;
    searchAbortRef.current?.abort();
    detailAbortRef.current?.abort();
    profileAbortRef.current?.abort();
    searchAbortRef.current = null;
    detailAbortRef.current = null;
    profileAbortRef.current = null;
    return generationRef.current;
  };

  const fetchProfileWithIdentity = async (
    query: string,
    identity: BaseNotesDetail,
    generation: number,
  ): Promise<FragranceMatch | null> => {
    profileAbortRef.current = new AbortController();
    const res = await fetch('/api/search-scent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        concentrationHint: concentrationHint === 'any' ? undefined : concentrationHint,
        selectedIdentity: identity,
      }),
      signal: profileAbortRef.current.signal,
    });
    if (generation !== generationRef.current) return null;
    if (!res.ok) {
      throw new Error(await apiErrorMessage(res, `Profile fetch failed: HTTP ${res.status}`));
    }
    const data = (await res.json()) as FragranceMatch;
    if (data && (data as any).error) {
      throw new Error(String((data as any).error));
    }
    return data;
  };

  const fetchProfileFromQuery = async (
    query: string,
    generation: number,
  ): Promise<FragranceMatch | null> => {
    profileAbortRef.current = new AbortController();
    const res = await fetch('/api/search-scent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        concentrationHint: concentrationHint === 'any' ? undefined : concentrationHint,
      }),
      signal: profileAbortRef.current.signal,
    });
    if (generation !== generationRef.current) return null;
    if (!res.ok) {
      const fallback =
        res.status === 422
          ? "Search only supports fragrance names. Try 'Brand + Fragrance' (for example: Dior Sauvage)."
          : `Search failed: HTTP ${res.status}`;
      throw new Error(await apiErrorMessage(res, fallback));
    }
    const data = (await res.json()) as FragranceMatch;
    if (!data || (data as any).error) {
      throw new Error((data as any)?.error || 'Search returned no fragrance match');
    }
    return data;
  };

  const handleSearch = async (e?: React.FormEvent, overrideQuery?: string) => {
    if (e) e.preventDefault();
    const targetQuery = (overrideQuery !== undefined ? overrideQuery : searchQuery).trim();
    if (!targetQuery) return;

    const generation = beginNewSearch();
    dispatch({ type: 'startSearch', query: targetQuery });
    setStatusLine('Searching BaseNotes...');

    searchAbortRef.current = new AbortController();
    let candidates: BaseNotesCandidate[] = [];
    let basenotesUnavailable = false;
    let basenotesUnavailableReason = '';

    try {
      const res = await fetch('/api/basenotes/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: targetQuery }),
        signal: searchAbortRef.current.signal,
      });
      if (generation !== generationRef.current) return;
      if (!res.ok) {
        basenotesUnavailableReason = await apiErrorMessage(
          res,
          `BaseNotes search failed: HTTP ${res.status}`,
        );
        basenotesUnavailable = true;
      } else {
        const data = (await res.json()) as { ok: boolean; candidates?: BaseNotesCandidate[]; error?: string };
        if (!data.ok) {
          basenotesUnavailableReason = data.error || 'BaseNotes search failed';
          basenotesUnavailable = true;
        } else {
          candidates = Array.isArray(data.candidates) ? data.candidates : [];
        }
      }
    } catch (err) {
      if (aborted(err)) return;
      basenotesUnavailable = true;
      basenotesUnavailableReason =
        err instanceof Error ? err.message : 'BaseNotes request failed';
    }

    if (generation !== generationRef.current) return;

    if (!basenotesUnavailable && candidates.length > 0) {
      dispatch({ type: 'candidatesLoaded', query: targetQuery, candidates });
      setStatusLine('');
      return;
    }

    // No BaseNotes candidates — fall back to the original /search-scent path.
    // Surface the fallback explicitly per the no-hidden-fallback rule.
    setStatusLine('Researching Fragrance...');
    try {
      const profile = await fetchProfileFromQuery(targetQuery, generation);
      if (generation !== generationRef.current) return;
      if (!profile) return;
      dispatch({
        type: 'profileLoaded',
        query: targetQuery,
        profile,
        identity: null,
        basenotesUnavailable: true,
      });
      setStatusLine(
        basenotesUnavailableReason
          ? `BaseNotes unavailable (${basenotesUnavailableReason}). Used built-in search.`
          : 'BaseNotes returned no matches. Used built-in search.',
      );
    } catch (err) {
      if (aborted(err)) return;
      if (generation !== generationRef.current) return;
      dispatch({
        type: 'profileFailed',
        message: err instanceof Error ? err.message : 'Search failed.',
      });
      setStatusLine('');
    }
  };

  const handleSelectCandidate = async (idx: number) => {
    if (phase.kind !== 'showing_candidates') return;
    if (phase.selectionLocked) return;
    const { query, candidates } = phase;
    const candidate = candidates[idx];
    if (!candidate) return;

    const generation = generationRef.current;
    detailAbortRef.current?.abort();
    profileAbortRef.current?.abort();

    dispatch({ type: 'selectCandidate', query, candidates, idx });
    setStatusLine(`Loading ${candidate.searchLabel}...`);

    detailAbortRef.current = new AbortController();
    let detail: BaseNotesDetail | null = null;
    try {
      const res = await fetch('/api/basenotes/detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: candidate.url }),
        signal: detailAbortRef.current.signal,
      });
      if (generation !== generationRef.current) return;
      if (!res.ok) {
        const message = await apiErrorMessage(res, `BaseNotes detail failed: HTTP ${res.status}`);
        dispatch({ type: 'detailFailed', query, candidates, selectedIdx: idx, message });
        setStatusLine('');
        return;
      }
      const data = (await res.json()) as { ok: boolean; detail?: BaseNotesDetail; error?: string };
      if (!data.ok || !data.detail) {
        dispatch({
          type: 'detailFailed',
          query,
          candidates,
          selectedIdx: idx,
          message: data.error || 'BaseNotes detail unavailable',
        });
        setStatusLine('');
        return;
      }
      detail = data.detail;
    } catch (err) {
      if (aborted(err)) return;
      if (generation !== generationRef.current) return;
      dispatch({
        type: 'detailFailed',
        query,
        candidates,
        selectedIdx: idx,
        message: err instanceof Error ? err.message : 'BaseNotes detail failed',
      });
      setStatusLine('');
      return;
    }

    if (generation !== generationRef.current || !detail) return;

    dispatch({ type: 'detailLoaded', query, candidates, selectedIdx: idx, detail });
    setStatusLine('Building scent profile...');

    try {
      const profile = await fetchProfileWithIdentity(query, detail, generation);
      if (generation !== generationRef.current) return;
      if (!profile) return;
      dispatch({
        type: 'profileLoaded',
        query,
        profile,
        identity: detail,
        basenotesUnavailable: false,
      });
      setStatusLine('Intelligence Collation Complete.');
    } catch (err) {
      if (aborted(err)) return;
      if (generation !== generationRef.current) return;
      dispatch({
        type: 'profileFailed',
        message: err instanceof Error ? err.message : 'Profile fetch failed.',
      });
      setStatusLine('');
    }
  };

  const retryCurrentSelection = () => {
    if (phase.kind === 'showing_candidates' && phase.selectedIdx !== null) {
      handleSelectCandidate(phase.selectedIdx);
      return;
    }
    handleSearch();
  };

  const resetState = () => {
    beginNewSearch();
    dispatch({ type: 'reset' });
    setSearchQuery('');
    setStatusLine('');
  };

  const handleConfirm = async () => {
    if (phase.kind !== 'complete' || !onAdd) return;
    const profile = phase.profile;

    if (profile.scent_vector) {
      const familyStr = (profile.family as string) || '';
      onAdd({
        ...profile,
        id: newFragranceId(),
        season: familyStr.includes('Fresh') ? 'Summer' : familyStr.includes('Woody') ? 'Winter' : 'Universal',
      });
      resetState();
      return;
    }

    syncAbortRef.current?.abort();
    syncAbortRef.current = new AbortController();
    setSyncing(true);
    setStatusLine('Finalizing Neural Link...');

    try {
      const res = await fetch('/api/scent-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: profile.name,
          brand: profile.brand,
          notes: profile.notes,
          family: profile.family,
          description: profile.description,
          pyramid: profile.pyramid,
          perfumer: profile.perfumer,
        }),
        signal: syncAbortRef.current.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && !data.error) {
        onAdd({
          ...data,
          name: data.name || data.product?.name || profile.name,
          brand: data.brand || data.product?.brand || profile.brand,
          imageUrl: data.imageUrl || profile.imageUrl || '',
          id: newFragranceId(),
          season: 'Universal',
        });
        resetState();
      } else {
        dispatch({
          type: 'profileFailed',
          message: data?.error || 'Could not sync to vault. Please try again.',
        });
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      dispatch({
        type: 'profileFailed',
        message: 'Vault sync failed. Please check your connection.',
      });
    } finally {
      setSyncing(false);
    }
  };

  const showOverlay =
    phase.kind === 'searching_candidates' ||
    phase.kind === 'fetching_detail' ||
    phase.kind === 'fetching_profile' ||
    syncing;
  const overlayLabel = statusLine || 'Researching Fragrance...';
  const showCandidates =
    phase.kind === 'showing_candidates' ||
    phase.kind === 'fetching_detail' ||
    phase.kind === 'fetching_profile';
  const showCompleteMatch = phase.kind === 'complete';
  const completeMatch = showCompleteMatch ? phase.profile : null;
  const candidates =
    phase.kind === 'showing_candidates' ||
    phase.kind === 'fetching_detail' ||
    phase.kind === 'fetching_profile'
      ? phase.candidates
      : [];
  const candidateSelectedIdx =
    phase.kind === 'showing_candidates'
      ? phase.selectedIdx
      : phase.kind === 'fetching_detail' || phase.kind === 'fetching_profile'
        ? phase.selectedIdx
        : null;
  const candidateLocked =
    phase.kind === 'fetching_detail' || phase.kind === 'fetching_profile';
  const candidateError =
    phase.kind === 'showing_candidates' ? phase.candidateError : null;
  const errorMessage = phase.kind === 'error' ? phase.message : null;
  const noBaseNotesMatches =
    phase.kind === 'showing_candidates' && candidates.length === 0 && !candidateError;
  const showFallbackBanner =
    phase.kind === 'complete' && phase.basenotesUnavailable;

  return (
    <div className="glass-shell rounded-[var(--radius-scent)] relative overflow-hidden">
      {showOverlay && (
        <div className="absolute inset-0 bg-black/90 backdrop-blur-xl z-50 flex flex-col items-center justify-center p-8 text-center">
          <motion.div
            animate={{ rotate: [0, 360], scale: [1, 1.1, 1] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
            className="w-20 h-20 border-t-2 border-white/40 rounded-full mb-6"
          />
          <h3 className="font-serif italic text-xl text-white mb-2">{overlayLabel}</h3>
          <p className="text-white/30 text-[10px] uppercase tracking-[0.3em] font-sans font-bold italic animate-pulse">
            Processing Olfactory Data
          </p>
        </div>
      )}
      <div className="glass rounded-[var(--radius-scent-inner)] p-4 md:p-6">
        <div className="flex flex-col items-center text-center mb-7 px-2 gap-5">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-scent-accent/82 font-bold mb-1">Add To Vault</p>
            <h2 className="font-serif italic text-2xl text-[#fff7ec] tracking-normal">Capture Essence</h2>
          </div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-[#d6c2a8]/78 font-bold">Search Mode</p>
        </div>

        <AnimatePresence>
          {errorMessage && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-scent"
            >
              <div className="flex items-start gap-3 mb-2">
                <div className="mt-0.5 w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />
                <p className="text-[10px] text-red-500/90 font-medium leading-relaxed">{errorMessage}</p>
              </div>
              <button
                onClick={retryCurrentSelection}
                className="text-[9px] uppercase tracking-widest text-red-500 font-bold hover:underline ml-4"
              >
                Try Again
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="space-y-5">
          <form onSubmit={handleSearch} className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Enter Fragrance Name..."
              className="scent-lux-input w-full h-[58px] sm:h-[62px] px-12 text-center text-[#fff7ec] font-sans text-[15px] outline-none transition-colors placeholder:text-[#d9c2a4]/56"
            />
            <button
              type="submit"
              disabled={showOverlay}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-2.5 text-scent-accent/78 hover:text-white transition-colors disabled:opacity-50"
            >
              {showOverlay ? <RefreshCw size={16} className="animate-spin" /> : <Search size={18} />}
            </button>
          </form>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <span className="text-[10px] uppercase tracking-[0.24em] text-[#d6c2a8]/68 font-bold">Concentration</span>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {CONCENTRATION_OPTIONS.map((option) => {
                const selected = concentrationHint === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setConcentrationHint(option.id)}
                    className={`min-h-7 px-3 py-1 rounded-full text-[10px] uppercase tracking-[0.16em] border font-bold transition-all ${
                      selected
                        ? 'bg-scent-accent text-black border-scent-accent shadow-[0_0_18px_rgba(201,139,44,0.18)]'
                        : 'bg-black/28 text-[#d6c2a8]/72 border-scent-accent/24 hover:text-white hover:border-scent-accent/52 hover:bg-white/[0.07]'
                    }`}
                    aria-pressed={selected}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 justify-center">
            {QUICK_SEARCH_TAGS.map(tag => (
              <button
                key={tag}
                type="button"
                onClick={() => {
                  setSearchQuery(tag);
                  handleSearch(undefined, tag);
                }}
                className="min-h-7 px-3 py-1 bg-black/24 rounded-full text-[10px] uppercase tracking-[0.16em] text-[#d6c2a8]/70 hover:text-white hover:bg-white/[0.08] transition-all border border-scent-accent/18"
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        <AnimatePresence>
          {candidateError && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="mt-6 p-3 bg-amber-500/10 border border-amber-500/30 rounded-scent flex items-start gap-3"
            >
              <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-[10px] text-amber-200/90 font-medium leading-relaxed mb-1">{candidateError}</p>
                <div className="flex gap-3">
                  <button
                    onClick={retryCurrentSelection}
                    className="text-[9px] uppercase tracking-widest text-amber-300 font-bold hover:underline"
                  >
                    Retry
                  </button>
                  <button
                    onClick={resetState}
                    className="text-[9px] uppercase tracking-widest text-amber-200/60 font-bold hover:underline"
                  >
                    Start Over
                  </button>
                </div>
              </div>
            </motion.div>
          )}

          {showCandidates && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="mt-8 pt-6 border-t border-white/10"
            >
              <p className="text-[9px] uppercase tracking-[0.4em] text-scent-muted mb-4 font-bold text-center">
                BaseNotes Candidates
              </p>
              {noBaseNotesMatches ? (
                <p className="text-center text-[10px] text-scent-muted leading-relaxed">
                  No BaseNotes matches. Refine the query and try again, or wait while built-in search runs.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  {candidates.map((candidate, i) => {
                    const isSelected = candidateSelectedIdx === i;
                    const isDisabled = candidateLocked && !isSelected;
                    return (
                      <button
                        key={candidate.url}
                        type="button"
                        onClick={() => handleSelectCandidate(i)}
                        disabled={isDisabled || candidateLocked}
                        className={`flex items-center justify-between p-3 border transition-all rounded-[1.25rem] text-left ${
                          isSelected ? 'border-white bg-white/10' : 'border-white/10 hover:bg-white/5'
                        } ${isDisabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-white/10 bg-white/5 text-[8px] font-bold uppercase text-white/30">
                            BN
                          </div>
                          <div>
                            <p className="font-serif italic text-lg leading-tight text-white">
                              {candidate.name}
                            </p>
                            <p className="text-[8px] uppercase text-scent-muted tracking-widest font-sans font-bold">
                              {[candidate.brand, candidate.year].filter(Boolean).join(' · ') || 'BaseNotes'}
                            </p>
                          </div>
                        </div>
                        {isSelected && <Check size={16} className="text-white" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </motion.div>
          )}

          {showCompleteMatch && completeMatch && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="mt-8 pt-6 border-t border-white/10"
            >
              <p className="text-[9px] uppercase tracking-[0.4em] text-scent-muted mb-4 font-bold text-center">
                Archive Match
              </p>
              {showFallbackBanner && (
                <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/20 rounded-scent flex items-start gap-3">
                  <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
                  <p className="text-[10px] text-amber-200/90 leading-relaxed">
                    BaseNotes matching was unavailable. Used built-in search instead.
                  </p>
                </div>
              )}
              <div className="grid grid-cols-1 gap-2">
                <div className="flex items-center justify-between p-3 border border-white bg-white/10 rounded-[1.25rem]">
                  <div className="flex items-center gap-3">
                    <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-sm border border-white/10 bg-white/5">
                      {completeMatch.imageUrl ? (
                        <BottleImage
                          variant="thumb"
                          src={completeMatch.imageUrl}
                          alt={completeMatch.name}
                          className="h-full w-full"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[8px] font-bold uppercase text-white/20">
                          N/A
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="font-serif italic text-lg leading-tight text-white">{completeMatch.name}</p>
                      <p className="text-[8px] uppercase text-scent-muted tracking-widest font-sans font-bold">
                        {completeMatch.brand}
                      </p>
                    </div>
                  </div>
                  <Check size={16} className="text-white" />
                </div>
              </div>
              <button
                onClick={handleConfirm}
                className="scent-primary-button w-full mt-6 h-14 font-serif italic text-lg hover:scale-[1.02] active:scale-95 transition-all rounded-[var(--radius-scent)]"
              >
                Sync to Vault
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
