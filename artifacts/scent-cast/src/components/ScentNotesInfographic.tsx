import React from 'react';
import {
  collectMainAccordDisplayRows,
  type DerivedMetrics,
} from '@/lib/fragranceApi';

interface ScentNotesInfographicProps {
  /** Preferred: Railway `derived_metrics.notes` (+ main accords summary). */
  derivedMetrics?: DerivedMetrics | null;
  /** Legacy wardrobe pyramid when engine notes are absent. */
  legacyPyramid?: {
    top: string[];
    heart: string[];
    base: string[];
  };
  /** Desktop modal renders accord and note panels in different columns. */
  variant?: "all" | "accords" | "notes";
}

function resolvePyramid(
  derivedMetrics?: DerivedMetrics | null,
  legacy?: ScentNotesInfographicProps["legacyPyramid"],
): { top: string[]; heart: string[]; base: string[]; flat: string[] } {
  const n = derivedMetrics?.notes;
  if (n) {
    return {
      top: [...(n.top ?? [])].filter(Boolean),
      heart: [...(n.heart ?? [])].filter(Boolean),
      base: [...(n.base ?? [])].filter(Boolean),
      flat: [...(n.flat ?? [])].filter(Boolean),
    };
  }
  if (legacy) {
    return {
      top: [...(legacy.top ?? [])].filter(Boolean),
      heart: [...(legacy.heart ?? [])].filter(Boolean),
      base: [...(legacy.base ?? [])].filter(Boolean),
      flat: [],
    };
  }
  return { top: [], heart: [], base: [], flat: [] };
}

function hasAnyNotes(p: { top: string[]; heart: string[]; base: string[]; flat: string[] }): boolean {
  return p.top.length > 0 || p.heart.length > 0 || p.base.length > 0 || p.flat.length > 0;
}

function strengthValue(row: { score?: number; pct?: number }): number | null {
  const raw = typeof row.pct === "number" ? row.pct : typeof row.score === "number" ? row.score : null;
  if (raw === null || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function Panel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`border border-white/10 bg-white/[0.025] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] ${className}`}>
      <div className="border-b border-white/[0.07] px-4 py-3 text-center">
        <p className="text-[10px] uppercase tracking-[0.34em] text-white/70 font-bold">
          {title}
        </p>
      </div>
      {children}
    </section>
  );
}

function AccordPanel({
  rows,
  summary,
}: {
  rows: ReturnType<typeof collectMainAccordDisplayRows>;
  summary: string;
}) {
  if (rows.length === 0 && !summary) {
    return (
      <Panel title="Main Accords">
        <div className="px-4 py-6 text-center">
          <p className="text-sm italic text-white/45 font-serif">Accords unavailable.</p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Main Accords">
      <div className="space-y-3 px-4 py-4">
        {summary ? (
          <p className="text-center text-sm italic text-white/58 font-serif leading-relaxed">
            {summary}
          </p>
        ) : null}
        <div className="space-y-2.5">
          {rows.slice(0, 10).map((row) => {
            const value = strengthValue(row);
            return (
              <div key={row.label} className="grid grid-cols-[4.8rem_1fr_2.4rem] items-center gap-3">
                <p className="truncate text-xs text-white/68">{row.label}</p>
                <div className="h-px bg-white/10">
                  <div
                    className="h-px bg-scent-accent shadow-[0_0_10px_rgba(201,139,44,0.32)]"
                    style={{ width: `${value ?? 20}%` }}
                  />
                </div>
                <p className="text-right text-xs text-white/78 tabular-nums">{value ?? "--"}</p>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

function NotesPanel({
  pyramid,
}: {
  pyramid: { top: string[]; heart: string[]; base: string[]; flat: string[] };
}) {
  const groups = [
    { key: "top", label: "Top", color: "bg-amber-300", notes: pyramid.top },
    { key: "heart", label: "Heart", color: "bg-emerald-400", notes: pyramid.heart },
    { key: "base", label: "Base", color: "bg-orange-400", notes: pyramid.base },
    { key: "notes", label: "Notes", color: "bg-scent-accent", notes: pyramid.flat },
  ].filter((group) => group.notes.length > 0);

  if (groups.length === 0) {
    return (
      <Panel title="Notes">
        <div className="px-4 py-6 text-center">
          <p className="text-sm italic text-white/45 font-serif">Notes unavailable for this fragrance.</p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Notes" className="overflow-hidden">
      <div className="grid gap-4 px-4 py-4 sm:grid-cols-[8.5rem_1fr] sm:items-center">
        <div className="hidden sm:block">
          <svg viewBox="0 0 160 144" className="h-32 w-full overflow-visible">
            <path d="M80 10 L116 55 H44 Z" fill="rgba(201,139,44,0.10)" stroke="rgba(201,139,44,0.45)" />
            <path d="M43 61 H117 L143 103 H17 Z" fill="rgba(255,255,255,0.035)" stroke="rgba(255,255,255,0.14)" />
            <path d="M16 110 H144 L158 137 H2 Z" fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.12)" />
          </svg>
        </div>
        <div className="space-y-3">
          {groups.map((group) => {
            const visible = group.notes.slice(0, 5);
            const remaining = Math.max(0, group.notes.length - visible.length);
            return (
              <div key={group.key} className="grid grid-cols-[4.25rem_1fr_auto] items-start gap-3 border-b border-white/[0.06] pb-3 last:border-b-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${group.color}`} />
                  <p className="text-[10px] uppercase tracking-[0.24em] text-scent-accent font-bold">
                    {group.label}
                  </p>
                </div>
                <p className="font-serif italic text-sm leading-relaxed text-white/76">
                  {visible.join(" · ")}
                </p>
                {remaining > 0 ? (
                  <p className="text-[10px] text-scent-accent/80 whitespace-nowrap">+{remaining} more</p>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

export const ScentNotesInfographic: React.FC<ScentNotesInfographicProps> = ({
  derivedMetrics,
  legacyPyramid,
  variant = "all",
}) => {
  const pyramid = resolvePyramid(derivedMetrics, legacyPyramid);
  const accordRows = collectMainAccordDisplayRows(derivedMetrics?.main_accords);
  const accordSummary = derivedMetrics?.main_accords?.accord_summary?.trim() ?? '';
  const hasAccordVisual = accordRows.length > 0 || Boolean(accordSummary);
  const hasPyramid = hasAnyNotes(pyramid);

  if (!hasPyramid && !hasAccordVisual) {
    return (
      <Panel title={variant === "accords" ? "Main Accords" : "Notes"}>
        <div className="px-4 py-6 text-center">
          <p className="text-sm italic text-white/45 font-serif">Notes unavailable for this fragrance.</p>
        </div>
      </Panel>
    );
  }

  if (variant === "accords") {
    return <AccordPanel rows={accordRows} summary={accordSummary} />;
  }

  if (variant === "notes") {
    return <NotesPanel pyramid={pyramid} />;
  }

  return (
    <div id="scent-notes-infographic" className="space-y-3 sm:space-y-4">
      <AccordPanel rows={accordRows} summary={accordSummary} />
      <NotesPanel pyramid={pyramid} />
    </div>
  );
};
