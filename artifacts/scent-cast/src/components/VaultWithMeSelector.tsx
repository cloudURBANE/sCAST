import React from "react";
import { Check, CheckCircle2, LoaderCircle, Search, X } from "lucide-react";
import type { Fragrance } from "@/components/Wardrobe";
import { Drawer, DrawerClose, DrawerContent, DrawerTrigger } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { matchesWardrobeQuery } from "@/lib/wardrobeSearchSuggest";
import { sameWithMeSelection, withMeItemId, type WithMeState } from "@/lib/withMe";

const DESKTOP_QUERY = "(min-width: 768px)";

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = React.useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(DESKTOP_QUERY).matches
      : true,
  );
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
    setIsDesktop(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

function itemName(item: Fragrance): string {
  return item.name || item.product?.name || "Unknown fragrance";
}

function itemBrand(item: Fragrance): string {
  return item.brand || item.product?.brand || item.house || "";
}

type VaultWithMeSelectorProps = {
  items: Fragrance[];
  state: WithMeState;
  onSave: (next: { enabled: boolean; fragranceIds: string[] }) => Promise<void>;
  onAddFragrance?: () => void;
};

export function VaultWithMeSelector({
  items,
  state,
  onSave,
  onAddFragrance,
}: VaultWithMeSelectorProps): React.ReactElement {
  const isDesktop = useIsDesktop();
  const [open, setOpen] = React.useState(false);
  const [draftEnabled, setDraftEnabled] = React.useState(state.enabled);
  const [draftIds, setDraftIds] = React.useState<Set<string>>(() => new Set(state.fragranceIds));
  const [query, setQuery] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const lastCanonicalRevisionRef = React.useRef(state.updatedAt);

  const resetDraft = React.useCallback(() => {
    setDraftEnabled(state.enabled);
    setDraftIds(new Set(state.fragranceIds));
    setQuery("");
    setError(null);
  }, [state.enabled, state.fragranceIds]);

  const handleOpenChange = React.useCallback((next: boolean) => {
    if (busy) return;
    setOpen(next);
    if (next) resetDraft();
  }, [busy, resetDraft]);

  // A remote deletion can land while the manager is open. Keep the draft, but
  // remove ids that no longer belong to a visible vault row; new rows remain
  // unchecked until the user explicitly includes them.
  const itemIdsSignature = items.map(withMeItemId).join("|");
  React.useEffect(() => {
    if (!open) return;
    const owned = new Set(items.map(withMeItemId));
    setDraftIds((current) => {
      const next = new Set([...current].filter((id) => owned.has(id)));
      return sameWithMeSelection(current, next) ? current : next;
    });
  }, [itemIdsSignature, items, open]);

  // A 409 save response replaces `state` with the server's newer revision.
  // Reflect it in the still-open editor so "latest set is shown" is literally
  // true and the next save starts from the canonical selection.
  React.useEffect(() => {
    if (!open) {
      lastCanonicalRevisionRef.current = state.updatedAt;
      return;
    }
    if (!state.updatedAt || lastCanonicalRevisionRef.current === state.updatedAt) return;
    lastCanonicalRevisionRef.current = state.updatedAt;
    setDraftEnabled(state.enabled);
    setDraftIds(new Set(state.fragranceIds));
  }, [open, state.enabled, state.fragranceIds, state.updatedAt]);

  const filteredItems = React.useMemo(() => {
    const trimmed = query.trim();
    return trimmed ? items.filter((item) => matchesWardrobeQuery(item, trimmed)) : items;
  }, [items, query]);

  const changed =
    draftEnabled !== state.enabled || !sameWithMeSelection(draftIds, state.fragranceIds);

  const toggle = (id: string) => {
    setDraftEnabled(true);
    setDraftIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setError(null);
  };

  const submit = async (enabled = draftEnabled, ids = [...draftIds]) => {
    setBusy(true);
    setError(null);
    try {
      await onSave({ enabled, fragranceIds: enabled ? ids : [] });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update With Me.");
    } finally {
      setBusy(false);
    }
  };

  const triggerLabel = state.enabled
    ? `Choose the fragrances you have with you. ${state.fragranceIds.length} selected.`
    : "Choose the fragrances you have with you";
  const trigger = (
    <button
      type="button"
      disabled={!state.loaded}
      aria-label={triggerLabel}
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-scent-accent/28 bg-scent-surface/50 px-4 py-2 text-scent-accent shadow-[inset_0_1px_0_rgba(255,236,183,0.08)] transition-colors hover:border-scent-accent/55 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/50 disabled:cursor-wait disabled:opacity-45"
    >
      <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden />
      <span className="scent-type-label text-scent-accent/90">With Me</span>
      {state.enabled ? (
        <span className="min-w-5 rounded-full bg-scent-accent/14 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums">
          {state.fragranceIds.length}
        </span>
      ) : null}
    </button>
  );

  const content = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-white/10 pb-4">
        <p className="scent-type-label text-scent-accent/75">With Me</p>
        <h3 className="mt-1 font-serif text-2xl italic text-foreground">What&apos;s with you?</h3>
        <p className="mt-2 text-sm leading-6 text-scent-text-muted">
          Choose the bottles ScentBeam can recommend from right now. Nothing here removes a fragrance from your Vault.
        </p>
        <p className="mt-1 text-xs text-scent-text-subtle">
          This stays active until you change it. New Vault additions stay unchecked.
        </p>
      </div>

      <div className="shrink-0 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-scent-text-muted">
            {draftEnabled
              ? `${draftIds.size} ${draftIds.size === 1 ? "bottle" : "bottles"} with you`
              : "Using your full Vault"}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setDraftEnabled(true);
                setDraftIds(new Set(items.map(withMeItemId)));
              }}
              className="scent-type-chip rounded-full px-2.5 py-1 text-scent-text-muted hover:text-scent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftEnabled(true);
                setDraftIds(new Set());
              }}
              className="scent-type-chip rounded-full px-2.5 py-1 text-scent-text-muted hover:text-scent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45"
            >
              Clear
            </button>
          </div>
        </div>
        {items.length >= 6 ? (
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-scent-text-subtle" size={15} aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search your Vault"
              aria-label="Search fragrances in your Vault"
              className="h-10 w-full rounded-full border border-white/12 bg-black/35 pl-9 pr-4 text-sm text-foreground outline-none placeholder:text-scent-text-subtle focus:border-scent-accent/45"
            />
          </div>
        ) : null}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {items.length === 0 ? (
          <div className="rounded-scent border border-dashed border-scent-accent/20 px-5 py-8 text-center">
            <p className="font-serif text-xl italic text-foreground">Your Vault is empty</p>
            <p className="mt-2 text-sm text-scent-text-muted">Add a fragrance before building your With Me set.</p>
            {onAddFragrance ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onAddFragrance();
                }}
                className="mt-4 rounded-full border border-scent-accent/35 px-4 py-2 scent-type-chip text-scent-accent"
              >
                Add fragrance
              </button>
            ) : null}
          </div>
        ) : filteredItems.length === 0 ? (
          <p className="py-8 text-center text-sm text-scent-text-muted">No Vault bottles match that search.</p>
        ) : (
          filteredItems.map((item) => {
            const id = withMeItemId(item);
            const selected = draftEnabled && draftIds.has(id);
            return (
              <button
                key={id}
                type="button"
                role="checkbox"
                aria-checked={selected}
                onClick={() => toggle(id)}
                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/45 ${
                  selected
                    ? "border-scent-accent/42 bg-scent-accent/[0.09]"
                    : "border-white/10 bg-white/[0.025] hover:border-white/20"
                }`}
              >
                <span className="flex h-12 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/30">
                  {item.imageUrl ? <img src={item.imageUrl} alt="" className="h-full w-full object-contain" loading="lazy" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] uppercase text-scent-text-subtle">{itemBrand(item)}</span>
                  <span className="block truncate font-serif text-base italic text-foreground">{itemName(item)}</span>
                </span>
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                    selected ? "border-scent-accent bg-scent-accent text-[#1a1206]" : "border-white/20 text-transparent"
                  }`}
                  aria-hidden
                >
                  <Check size={14} strokeWidth={2.25} />
                </span>
              </button>
            );
          })
        )}
      </div>

      {draftEnabled && draftIds.size === 0 ? (
        <p role="status" className="mt-3 shrink-0 rounded-lg border border-scent-accent/18 bg-scent-accent/[0.05] px-3 py-2 text-xs leading-5 text-scent-text-muted">
          No bottle is selected. ScentBeam won&apos;t suggest an owned fragrance until you add one here or use your full Vault.
        </p>
      ) : null}
      {error ? <p role="alert" className="mt-3 shrink-0 text-sm text-red-300">{error}</p> : null}

      <div className="mt-4 flex shrink-0 items-center gap-2 border-t border-white/10 pt-4">
        <button
          type="button"
          onClick={() => void submit(false, [])}
          disabled={busy || (!state.enabled && !changed)}
          className="min-h-11 rounded-full px-3 scent-type-chip text-scent-text-muted hover:text-foreground disabled:opacity-35"
        >
          Use full Vault
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => handleOpenChange(false)}
          disabled={busy}
          className="min-h-11 rounded-full px-4 scent-type-chip text-scent-text-muted hover:text-foreground disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !changed}
          aria-busy={busy}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-scent-accent/45 bg-scent-accent/12 px-4 scent-type-chip text-scent-accent hover:bg-scent-accent/18 disabled:cursor-not-allowed disabled:opacity-35"
        >
          {busy ? <LoaderCircle size={14} className="animate-spin" aria-hidden /> : null}
          Save With Me
        </button>
      </div>
    </div>
  );

  // Radix Popover and vaul Drawer both portal their surfaces. Mount exactly one
  // primitive for the active breakpoint; CSS-hiding one would leave its scrim
  // active and swallow pointer events.
  if (isDesktop) {
    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          align="center"
          sideOffset={10}
          className="flex h-[min(36rem,75vh)] w-[28rem] flex-col rounded-[20px] border-scent-accent/20 bg-[#090604]/97 p-5 text-scent-text-primary shadow-[0_24px_70px_rgba(0,0,0,0.72)] backdrop-blur-md"
        >
          {content}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent className="flex max-h-[88vh] flex-col border-scent-accent/18 bg-[#090604]/98 px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-scent-text-primary backdrop-blur-md">
        <div className="flex shrink-0 justify-end pt-2">
          <DrawerClose asChild>
            <button type="button" disabled={busy} aria-label="Close With Me" className="rounded-full p-2 text-scent-text-subtle hover:bg-white/10 hover:text-white">
              <X size={17} aria-hidden />
            </button>
          </DrawerClose>
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden pb-1">{content}</div>
      </DrawerContent>
    </Drawer>
  );
}
