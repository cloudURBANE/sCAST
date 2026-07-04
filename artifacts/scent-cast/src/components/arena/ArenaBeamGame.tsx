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
import { useAuth } from "@/context/AuthContext";
import type { ArenaBattleSide } from "@/components/arena/arenaBattleMapper";
import {
  ARENA_BEAM_BOARD_SIZE,
  ARENA_BEAM_TARGET_SCORE,
  beamPowerForScore,
  beamTickMs,
  cashOutBeamRun,
  createInitialBeamGameState,
  pointsEqual,
  stepBeamGame,
  turnBeamSnake,
  type BeamDirection,
} from "@/components/arena/arenaBeamGameCore";
import {
  readBeamRunStats,
  recordBeamPowerClaim,
  recordBeamRunEnd,
  type BeamRunStats,
} from "@/components/arena/arenaBeamRunStore";

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

const EMPTY_STATS: BeamRunStats = { bestScore: 0, totalRuns: 0, totalBeamPower: 0 };

// Beam trail base tone (#b9912f) — head stays solid scent-accent, the body
// fades from near-solid amber toward a deep dark tail against the board.
const TRAIL_ALPHA_HEAD = 0.95;
const TRAIL_ALPHA_TAIL = 0.35;

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
  const { authEmail, authUsername } = useAuth();
  const [game, setGame] = useState(createInitialBeamGameState);
  const [runId, setRunId] = useState(createRunId);
  const [localError, setLocalError] = useState<string | null>(null);
  const [stats, setStats] = useState<BeamRunStats>(EMPTY_STATS);
  const [isNewBest, setIsNewBest] = useState(false);
  const [cashedOut, setCashedOut] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const sparksEatenRef = useRef(0);
  const runEndRecordedRef = useRef(false);
  const finePointer = useFinePointer(open);

  const userKey = signedIn && authEmail ? authEmail : "guest";

  const playerName = useMemo(() => {
    if (!signedIn) return null;
    const fromUsername = authUsername?.trim().split(/\s+/)[0];
    if (fromUsername) return fromUsername;
    const localPart = authEmail?.split("@")[0]?.trim();
    return localPart || null;
  }, [signedIn, authUsername, authEmail]);

  // Map "x:y" → segment index (0 = head) so the trail gradient can be
  // computed per cell in a single pass.
  const segmentByCell = useMemo(() => {
    const map = new Map<string, number>();
    game.snake.forEach((point, index) => {
      const key = `${point.x}:${point.y}`;
      if (!map.has(key)) map.set(key, index);
    });
    return map;
  }, [game.snake]);

  useEffect(() => {
    sparksEatenRef.current = game.sparksEaten;
  }, [game.sparksEaten]);

  useEffect(() => {
    if (!open) return;
    setGame(createInitialBeamGameState());
    setRunId(createRunId());
    setLocalError(null);
    setIsNewBest(false);
    setCashedOut(false);
    runEndRecordedRef.current = false;
    setStats(readBeamRunStats(userKey));
    setReducedMotion(
      typeof window !== "undefined" &&
        !!window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
  }, [open, side?.key, userKey]);

  useEffect(() => {
    if (!open || game.status !== "playing") return;

    const loop = (time: number) => {
      if (lastTickRef.current === null) lastTickRef.current = time;
      if (time - lastTickRef.current >= beamTickMs(sparksEatenRef.current, reducedMotion)) {
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
  }, [open, game.status, reducedMotion]);

  // Record each run end exactly once (guarded by ref; reset on open/retry).
  useEffect(() => {
    if (!open) return;
    if (game.status !== "won" && game.status !== "lost") return;
    if (runEndRecordedRef.current) return;
    runEndRecordedRef.current = true;
    const result = recordBeamRunEnd(userKey, game.score);
    setStats(result.stats);
    setIsNewBest(result.isNewBest);
  }, [open, game.status, game.score, userKey]);

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
    setIsNewBest(false);
    setCashedOut(false);
    runEndRecordedRef.current = false;
  };

  const bankRun = () => {
    if (game.status === "playing" && game.score >= ARENA_BEAM_TARGET_SCORE) {
      setCashedOut(true);
    }
    setGame((current) => cashOutBeamRun(current));
  };

  const claim = async () => {
    if (!signedIn) {
      onSignIn();
      return;
    }
    try {
      setLocalError(null);
      await onClaim(game.score, runId);
      recordBeamPowerClaim(userKey, beamPowerForScore(game.score));
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

  const beamPower = beamPowerForScore(game.score);
  const claimable = beamPower > 0;
  const ended = game.status === "won" || game.status === "lost";
  const crashed = game.status === "lost" || (game.status === "won" && !cashedOut);
  const liveBest = Math.max(stats.bestScore, game.score);
  const beatingBest = stats.bestScore > 0 && game.score > stats.bestScore;

  const message = (() => {
    if (game.status === "won") {
      return cashedOut
        ? `Run banked: +${beamPower} Beam Power at ${game.score} sparks.`
        : `The beam broke at ${game.score} — your +${beamPower} Beam Power stays banked.`;
    }
    if (game.status === "lost") {
      const shortfall = ARENA_BEAM_TARGET_SCORE - game.score;
      return `The beam broke ${shortfall} spark${shortfall === 1 ? "" : "s"} short of claimable. Run it back.`;
    }
    if (game.status === "playing") {
      return claimable
        ? "Every 4 sparks banks another Beam Power — crash-safe."
        : `Reach ${ARENA_BEAM_TARGET_SCORE} to make the run claimable.`;
    }
    const greeting = playerName ? `Ready to run the beam, ${playerName}?` : "Ready to run the beam?";
    return stats.bestScore > 0
      ? `${greeting} Beat ${stats.bestScore} to set a new personal best.`
      : greeting;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-xl gap-0 overflow-x-hidden overflow-y-auto rounded-lg border border-scent-accent/18 bg-[rgba(5,4,3,0.97)] p-0 text-foreground shadow-[0_28px_90px_-48px_rgba(0,0,0,0.9),inset_0_1px_0_rgba(255,236,183,0.08)]">
        <div className="p-4 sm:p-5">
          <DialogHeader className="space-y-2 text-center">
            <p className="scent-type-label text-scent-accent">Scent Beam</p>
            <DialogTitle className="text-pretty text-balance text-xl font-bold leading-tight text-foreground sm:text-2xl">
              Add Beam Power
            </DialogTitle>
            <DialogDescription
              aria-live="polite"
              className="mx-auto max-w-md text-xs font-medium leading-5 text-scent-text-muted sm:text-sm"
            >
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
                  <span
                    className={`block text-[8px] uppercase tracking-[0.08em] transition-colors ${beatingBest ? "text-scent-accent/90" : "text-scent-text-subtle"}`}
                  >
                    {beatingBest ? "New best" : "Best"}
                  </span>
                  <strong className={`text-sm transition-colors ${beatingBest ? "text-scent-accent" : "text-foreground"}`}>
                    {liveBest}
                  </strong>
                </div>
                <div className="rounded-md border border-white/8 bg-black/24 px-2 py-1.5">
                  <span className="block text-[8px] uppercase tracking-[0.08em] text-scent-text-subtle">Beam Power</span>
                  <strong className={`text-sm transition-colors ${beamPower > 0 ? "text-scent-accent" : "text-foreground"}`}>
                    {beamPower}
                  </strong>
                </div>
              </div>

              <div className="mb-2 flex min-h-[18px] items-center justify-center">
                {claimable ? (
                  <p className="text-center text-[11px] font-semibold text-scent-accent/90">
                    Claimable —{" "}
                    <span
                      key={beamPower}
                      className={`inline-block ${reducedMotion ? "" : "animate-in zoom-in-75 fade-in duration-300"}`}
                    >
                      +{beamPower}
                    </span>{" "}
                    Beam Power banked
                  </p>
                ) : (
                  <div
                    aria-hidden="true"
                    className="h-[3px] w-full overflow-hidden rounded-full bg-white/[0.07] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]"
                  >
                    <div
                      className="h-full rounded-full bg-scent-accent/80 transition-[width] duration-300"
                      style={{ width: `${Math.min(100, (game.score / ARENA_BEAM_TARGET_SCORE) * 100)}%` }}
                    />
                  </div>
                )}
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
                  const cellKey = `${point.x}:${point.y}`;
                  const segmentIndex = segmentByCell.get(cellKey);
                  const isHead = segmentIndex === 0;
                  const isBody = segmentIndex !== undefined && segmentIndex > 0;
                  const isFood = segmentIndex === undefined && pointsEqual(point, game.food);
                  const isRich = isFood && game.food.kind === "rich";

                  let cellClass = "m-[1px] rounded-[2px] bg-white/[0.035]";
                  let cellStyle: React.CSSProperties | undefined;
                  if (isHead) {
                    cellClass = crashed
                      ? `m-[1px] rounded-[3px] bg-[#a3574c] ${reducedMotion ? "" : "animate-in fade-in duration-300"}`
                      : "m-[1px] rounded-[3px] bg-scent-accent shadow-[inset_0_1px_0_rgba(255,247,219,0.6)]";
                  } else if (isBody && segmentIndex !== undefined) {
                    const t = segmentIndex / Math.max(game.snake.length - 1, 1);
                    const alpha = TRAIL_ALPHA_HEAD - (TRAIL_ALPHA_HEAD - TRAIL_ALPHA_TAIL) * t;
                    cellClass = "m-[1px] rounded-[2px]";
                    cellStyle = { backgroundColor: `rgba(185, 145, 47, ${alpha.toFixed(3)})` };
                  } else if (isRich) {
                    cellClass = "m-0 rounded-[3px] bg-[#ffe9b3] ring-1 ring-scent-accent/80 shadow-[inset_0_0_6px_rgba(212,175,55,0.55)]";
                  } else if (isFood) {
                    cellClass = `m-[1px] rounded-full bg-white ${reducedMotion ? "" : "animate-pulse"}`;
                  }

                  return (
                    <span key={cellKey} className={`transition-colors ${cellClass}`} style={cellStyle} />
                  );
                })}
              </div>

              {game.status === "playing" && claimable ? (
                <div className="mt-2 flex justify-center">
                  <button
                    type="button"
                    onClick={bankRun}
                    className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-scent-accent/30 bg-scent-accent/[0.08] px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-scent-accent transition-colors hover:bg-scent-accent/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-scent-accent/60"
                  >
                    Bank +{beamPower}
                  </button>
                </div>
              ) : finePointer && !claimable ? (
                <p className="mt-2 text-center text-[11px] font-medium text-scent-text-subtle">
                  Use arrow keys or WASD
                </p>
              ) : null}

              {ended && isNewBest ? (
                <p
                  className={`mt-2 text-center text-[11px] font-bold uppercase tracking-[0.1em] text-scent-accent ${reducedMotion ? "" : "animate-in zoom-in-95 fade-in duration-300"}`}
                >
                  New personal best!
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
                      {signedIn ? `Claim +${beamPower} Beam Power` : "Sign in"}
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
