import React from 'react';
import type { ArenaBattle } from '@/components/arena/arenaBattleMapper';

interface ArenaNextRailProps {
  battles: ArenaBattle[];
  activeId: string | null;
  onSelect: (index: number) => void;
}

export const ArenaNextRail: React.FC<ArenaNextRailProps> = ({ battles, activeId, onSelect }) => {
  if (battles.length <= 1) return null;

  return (
    <aside className="mx-auto mt-12 w-full max-w-[1320px]" aria-label="Upcoming arena battles">
      <p className="mb-3 scent-type-label text-scent-accent/80">Next in arena</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {battles.map((battle, index) => {
          const active = battle.id === activeId;
          return (
            <button
              key={battle.id}
              type="button"
              onClick={() => onSelect(index)}
              aria-pressed={active}
              className={[
                'min-h-24 rounded-[18px] border bg-black/46 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55',
                active
                  ? 'border-scent-accent/48 text-[#fff7ec]'
                  : 'border-scent-accent/16 text-scent-text-muted hover:border-scent-accent/36 hover:text-[#fff7ec]',
              ].join(' ')}
            >
              <span className="block scent-type-meta uppercase text-scent-accent/78">
                {battle.left.name} vs {battle.right.name}
              </span>
              <span className="mt-2 line-clamp-2 block font-serif text-lg italic leading-tight">
                {battle.title}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
};
