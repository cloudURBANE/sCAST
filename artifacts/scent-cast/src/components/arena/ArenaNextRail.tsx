import React from 'react';
import { BottleImage } from '@/components/BottleImage';
import type { ArenaBattle, ArenaBattleSide } from '@/components/arena/arenaBattleMapper';

interface ArenaNextRailProps {
  battles: ArenaBattle[];
  activeId: string | null;
  onSelect: (index: number) => void;
}

// Small framed packshot for the matchup pair. Depth comes from the inset
// hairline only — no projected glow (owner-rejected site-wide).
function RailThumb({ side }: { side: ArenaBattleSide }) {
  return (
    <span className="relative block h-14 w-11 shrink-0 overflow-hidden rounded-md bg-black/45 shadow-[inset_0_0_0_1px_rgba(212,175,55,0.14)]">
      <BottleImage
        src={side.imageUrl}
        alt=""
        variant="thumb"
        className="absolute inset-1"
        loading="lazy"
      />
    </span>
  );
}

export const ArenaNextRail: React.FC<ArenaNextRailProps> = ({ battles, activeId, onSelect }) => {
  if (battles.length <= 1) return null;
  const upcomingBattles = battles
    .map((battle, index) => ({ battle, index }))
    .filter(({ battle }) => battle.id !== activeId);
  if (upcomingBattles.length === 0) return null;

  return (
    <aside className="mx-auto mt-12 w-full max-w-4xl" aria-label="Upcoming arena battles">
      {/* Centered to sit on the same axis as the stage above — the whole arena
          page reads down one centered spine. */}
      <p className="mb-4 text-center scent-type-label text-scent-accent/80">Next in arena</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {upcomingBattles.map(({ battle, index }) => {
          const leftVotes = Math.max(0, Number(battle.votes[battle.left.key]) || 0);
          const rightVotes = Math.max(0, Number(battle.votes[battle.right.key]) || 0);
          const totalVotes = leftVotes + rightVotes;
          const leftShare = totalVotes > 0 ? Math.round((leftVotes / totalVotes) * 100) : 50;
          const leader =
            totalVotes === 0 || leftVotes === rightVotes
              ? null
              : leftVotes > rightVotes
                ? battle.left
                : battle.right;
          return (
            <button
              key={battle.id}
              type="button"
              onClick={() => onSelect(index)}
              aria-label={`Open battle: ${battle.title}`}
              className="group flex min-h-24 min-w-0 flex-col rounded-lg border border-scent-accent/16 bg-black/62 px-4 py-3.5 text-left text-scent-text-muted shadow-[inset_0_1px_0_rgba(255,236,183,0.04),0_16px_36px_-28px_rgba(0,0,0,0.8)] transition-all duration-200 hover:border-scent-accent/36 hover:bg-scent-accent/[0.06] hover:text-foreground hover:shadow-[inset_0_1px_0_rgba(255,236,183,0.07),0_18px_42px_-28px_rgba(0,0,0,0.82)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
            >
              <span className="flex items-center gap-3">
                {/* The matchup pair, face to face — the same packshot language the
                    stage and community battle cards speak, in miniature. */}
                <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                  <RailThumb side={battle.left} />
                  <span className="px-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-scent-accent/70">
                    vs
                  </span>
                  <RailThumb side={battle.right} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 block scent-type-meta uppercase leading-snug text-scent-accent/78">
                    {battle.left.name} vs {battle.right.name}
                  </span>
                  <span className="mt-1.5 line-clamp-2 block text-base font-bold leading-tight text-foreground/90">
                    {battle.title}
                  </span>
                </span>
              </span>
              {/* Live tally strip: a quiet split bar plus the running count, so a
                  battle's heat is visible before opening it. Hairline fills only —
                  the gold segment is the left side's share of the room. */}
              <span className="mt-3 block" aria-hidden="true">
                <span className="block h-1 w-full overflow-hidden rounded-full bg-white/10">
                  {totalVotes > 0 ? (
                    <span
                      className="block h-full rounded-full bg-gradient-to-r from-scent-accent to-[#e7c45f] transition-[width] duration-300"
                      style={{ width: `${leftShare}%` }}
                    />
                  ) : null}
                </span>
                <span className="mt-1.5 flex items-baseline justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-scent-text-subtle">
                  <span className="truncate">
                    {leader ? `${leader.name} leads` : totalVotes > 0 ? 'Dead even' : 'No votes yet'}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {totalVotes > 0
                      ? `${totalVotes} ${totalVotes === 1 ? 'vote' : 'votes'}`
                      : 'Be first'}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
};
