import React, { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BottleImage } from "@/components/BottleImage";
import { BrandGoldLabel } from "@/components/BrandGoldLabel";
import type { ArenaBattleSide } from "@/components/arena/arenaBattleMapper";
import {
  ARENA_BEAM_BOARD_SIZE,
  ARENA_BEAM_TARGET_SCORE,
  createInitialBeamGameState,
  pointsEqual,
  stepBeamGame,
  turnBeamSnake,
  type BeamDirection,
} from "@/components/arena/arenaBeamGameCore";

const KEY_TO_DIRECTION: Record<string, BeamDirection | undefined> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  W: "up",
  a: "left",
  A: "left",
  s: "down",
  S: "down",
  d: "right",
  D: "right",
};

function createRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function useFinePointer(open: boolean): boolean {
  const [finePointer, setFinePointer] = useState(false);
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(pointer: fine)");
    const update = () => setFinePointer(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [open]);
  return finePointer;
}

interface ArenaBeamGameProps {
  open: boolean;
  side: ArenaBattleSide | null;
  submitting: boolean;
  errorMessage?: string | null;
  onOpenChange: (open: boolean) => void;
  onClaim: (score: number, runId: string) => Promise<void>;
  onSignIn: () => void;
  signedIn: boolean;
}

export const ArenaBeamGame: React.FC<ArenaBeamGameProps> = ({
  open,
  side,
  submitting,
  errorMessage,
  onOpenChange,
  onClaim,
  onSignIn,
  signedIn,
}) => {
  const [game, setGame] = useState(createInitialBeamGameState);
  const [runId, setRunId] = useState(createRunId);
  const [localError, setLocalError] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const finePointer = useFinePointer(open);

  const occupied = useMemo(() => new Set(game.snake.map((point) => `${point.x}:${point.y}`)), [game.snake]);

  useEffect(() => {
    if (!open) return;
    setGame(createInitialBeamGameState());
    setRunId(createRunId());
    setLocalError(null);
  }, [open, side?.key]);

  useEffect(() => {
    if (!open || game.status !== "playing") return;
    const tickMs = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 210
      : 145;

    const loop = (time: number) => {
      if (lastTickRef.current === null) lastTickRef.current = time;
      if (time - lastTickRef.current >= tickMs) {
        lastTickRef.current = time;
        setGame((current) => stepBeamGame(current));
      }
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTickRef.current = null;
    };
  }, [open, game.status]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = KEY_TO_DIRECTION[event.key];
      if (!direction) return;
      event.preventDefault();
      setGame((current) => {
        const turned = turnBeamSnake(current, direction);
        return turned.status === "ready" ? { ...turned, status: "playing" } : turned;
      });
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open]);

  const steer = (direction: BeamDirection) => {
    setGame((current) => {
      const turned = turnBeamSnake(current, direction);
      return turned.status === "ready" ? { ...turned, status: "playing" } : turned;
    });
  };

  const start = () => {
    setGame((current) => ({ ...current, status: "playing" }));
    setLocalError(null);
  };

  const retry = () => {
    setGame(createInitialBeamGameState());
    setRunId(createRunId());
    setLocalError(null);
  };

  const claim = async () => {
    if (!signedIn) {
      onSignIn();
      return;
    }
    try {
      setLocalError(null);
      await onClaim(game.score, runId);
      onOpenChange(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Beam Power could not be claimed.");
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const startPoint = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!startPoint) return;
    const dx = event.clientX - startPoint.x;
    const dy = event.clientY - startPoint.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
    steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
  };

  if (!side) return null;

  const message = (() => {
    if (game.status === "won") return "Beam target reached. Claim the run for this contender.";
    if (game.status === "lost") return "The beam broke. Run it back for a clean trail.";
    if (game.status === "playing") return "Collect scent sparks without crossing the trail.";
    return "Guide the beam to earn score-based Beam Power.";
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-xl gap-0 overflow-hidden rounded-lg border border-scent-accent/18 bg-[rgba(5,4,3,0.97)] p-0 text-foreground shadow-[0_28px_90px_-48px_rgba(0,0,0,0.9),inset_0_1px_0_rgba(255,236,183,0.08)]">
        <div className="p-4 sm:p-5">
          <DialogHeader className="space-y-2 text-center">
            <p className="scent-type-label text-scent-accent">Scent Beam</p>
            <DialogTitle className="text-pretty text-balance text-xl font-bold leading-tight text-foreground sm:text-2xl">
              Add Beam Power
            </DialogTitle>
            <DialogDescription className="mx-auto max-w-md text-xs font-medium leading-5 text-scent-text-muted sm:text-sm">
              {message}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-start">
            <div className="hidden min-w-0 sm:block">
              <div className="relative aspect-[4/5] overflow-hidden rounded-md bg-black/[0.2] shadow-[inset_0_0_0_1px_rgba(212,175,55,0.1)]">
                <BottleImage
                  src={side.imageUrl}
                  alt={`${side.name}${side.brand ? ` by ${side.brand}` : ""}`}
                  variant="card"
                  className="absolute inset-3"
                  imgClassName="brightness-[1.08] drop-shadow-[0_18px_24px_rgba(0,0,0,0.6)]"
                />
              </div>
              <div className="mt-2 text-center">
                {side.brand ? (
                  <BrandGoldLabel as="p" brand={side.brand} className="scent-card-brand scent-arena-brand mx-auto block max-w-full" shimmer={false} />
                ) : null}
                <p className="mt-1 line-clamp-2 text-xs font-bold leading-tight text-foreground">{side.name}</p>
              </div>
            </div>

            <div className="min-w-0">
              <div className="mb-2 grid grid-cols-3 gap-1.5 text-center">
                <div className="rounded-md border border-white/8 bg-black/24 px-2 py-1.5">
                  <span className="block text-[8px] uppercase tracking-[0.08em] text-scent-text-subtle">Score</span>
                  <strong className="text-sm text-foreground">{game.score}</strong>
                </div>
                <div className="rounded-md border border-white/8 bg-black/24 px-2 py-1.5">
                  <span className="block text-[8px] uppercase tracking-[0.08em] text-scent-text-subtle">Target</span>
                  <strong className="text-sm text-scent-accent">{ARENA_BEAM_TARGET_SCORE}</strong>
                </div>
                <div className="rounded-md border border-white/8 bg-black/24 px-2 py-1.5">
                  <span className="block text-[8px] uppercase tracking-[0.08em] text-scent-text-subtle">Run</span>
                  <strong className="text-sm capitalize text-foreground">{game.status}</strong>
                </div>
              </div>

              <div
                role="application"
                aria-label="Scent Beam game board"
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                style={{
                  touchAction: "none",
                  gridTemplateColumns: `repeat(${ARENA_BEAM_BOARD_SIZE}, minmax(0, 1fr))`,
                }}
                className="grid aspect-square w-full overflow-hidden rounded-lg border border-scent-accent/18 bg-[radial-gradient(circle_at_50%_45%,rgba(212,175,55,0.11),rgba(0,0,0,0.26)_38%,rgba(0,0,0,0.62))] p-1 shadow-[inset_0_0_0_1px_rgba(255,236,183,0.05)]"
              >
                {Array.from({ length: ARENA_BEAM_BOARD_SIZE * ARENA_BEAM_BOARD_SIZE }).map((_, index) => {
                  const point = { x: index % ARENA_BEAM_BOARD_SIZE, y: Math.floor(index / ARENA_BEAM_BOARD_SIZE) };
                  const isHead = pointsEqual(point, game.snake[0]);
                  const isSnake = occupied.has(`${point.x}:${point.y}`);
                  const isFood = pointsEqual(point, game.food);
                  return (
                    <span
                      key={`${point.x}:${point.y}`}
                      className={[
                        "m-[1px] rounded-[2px] transition-colors",
                        isHead ? "bg-scent-accent" : isSnake ? "bg-[#b9912f]" : isFood ? "bg-white" : "bg-white/[0.035]",
                        isFood ? "shadow-[0_0_0_1px_rgba(212,175,55,0.65),inset_0_0_8px_rgba(212,175,55,0.5)]" : "",
                      ].join(" ")}
                    />
                  );
                })}
              </div>

              {finePointer ? (
                <p className="mt-2 text-center text-[11px] font-medium text-scent-text-subtle">
                  Use arrow keys or WASD
                </p>
              ) : null}

              {(localError || errorMessage) ? (
                <p role="alert" className="mt-2 text-center text-xs font-medium text-red-100">
                  {localError || errorMessage}
                </p>
              ) : null}

              <div className="mt-3 grid grid-cols-2 gap-2">
                {game.status === "ready" ? (
                  <button
                    type="button"
                    onClick={start}
                    className="col-span-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-scent-accent px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] text-black transition-colors hover:bg-[#f0cf70] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70"
                  >
                    <Sparkles size={15} strokeWidth={2} aria-hidden="true" />
                    Start run
                  </button>
                ) : game.status === "won" ? (
                  <>
                    <button
                      type="button"
                      onClick={retry}
                      disabled={submitting}
                      className="min-h-11 rounded-md border border-scent-accent/16 bg-white/[0.035] px-3 py-2 text-xs font-bold uppercase tracking-[0.1em] text-scent-text-muted transition-colors hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55 disabled:pointer-events-none disabled:opacity-60"
                    >
                      New run
                    </button>
                    <button
                      type="button"
                      onClick={() => void claim()}
                      disabled={submitting}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-scent-accent px-3 py-2 text-xs font-bold uppercase tracking-[0.1em] text-black transition-colors hover:bg-[#f0cf70] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70 disabled:pointer-events-none disabled:opacity-60"
                    >
                      {submitting ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
                      {signedIn ? "Claim Beam Power" : "Sign in"}
                    </button>
                  </>
                ) : game.status === "lost" ? (
                  <button
                    type="button"
                    onClick={retry}
                    className="col-span-2 min-h-11 rounded-md bg-scent-accent px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] text-black transition-colors hover:bg-[#f0cf70] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/70"
                  >
                    Retry
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={retry}
                    className="col-span-2 min-h-11 rounded-md border border-scent-accent/16 bg-white/[0.035] px-4 py-2 text-xs font-bold uppercase tracking-[0.12em] text-scent-text-muted transition-colors hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/55"
                  >
                    Restart
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
