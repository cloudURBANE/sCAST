import React from 'react';
import type { ArenaBattle } from '@/components/arena/arenaBattleMapper';

interface ArenaNextRailProps {
  battles: ArenaBattle[];
  activeId: string | null;
  onSelect: (index: number) => void;
}

export const ArenaNextRail: React.FC<ArenaNextRailProps> = ({ battles, activeId, onSelect }) => {
  if (battles.length <= 1) return null;
  const upcomingBattles = battles
    .map((battle, index) => ({ battle, index }))
    .filter(({ battle }) => battle.id !== activeId);
  if (upcomingBattles.length === 0) return null;

  return (
    <aside className="mx-auto mt-12 w-full max-w-4xl" aria-label="Upcoming arena battles">
      <p className="mb-3 scent-type-label text-scent-accent/80">Next in arena</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {upcomingBattles.map(({ battle, index }) => {
          return (
            <button
              key={battle.id}
              type="button"
              onClick={() => onSelect(index)}
              className={[
                'min-h-24 rounded-lg border border-scent-accent/16 bg-black/62 px-4 py-3 text-left text-scent-text-muted shadow-[inset_0_1px_0_rgba(255,236,183,0.04),0_16px_36px_-28px_rgba(0,0,0,0.8)] transition-all duration-200 hover:border-scent-accent/36 hover:bg-scent-accent/[0.06] hover:text-foreground hover:shadow-[inset_0_1px_0_rgba(255,236,183,0.07),0_18px_42px_-28px_rgba(0,0,0,0.82)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55',
              ].join(' ')}
            >
              <span className="block scent-type-meta uppercase text-scent-accent/78">
                {battle.left.name} vs {battle.right.name}
              </span>
              <span className="mt-2 line-clamp-2 block text-base font-bold leading-tight text-foreground/90">
                {battle.title}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
};
