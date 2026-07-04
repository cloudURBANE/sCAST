export const ARENA_BEAM_BOARD_SIZE = 14;
export const ARENA_BEAM_TARGET_SCORE = 8; // min claimable score (server ARENA_BEAM_MIN_SCORE)
export const ARENA_BEAM_MAX_SCORE = 240; // server score clamp
export const ARENA_BEAM_POWER_STEP = 4; // server ARENA_BEAM_SCORE_STEP
export const ARENA_BEAM_MAX_POWER = 30; // server ARENA_BEAM_MAX_POWER
export const ARENA_BEAM_RICH_SPARK_INTERVAL = 4; // every 4th spark eaten is rich
export const ARENA_BEAM_RICH_SPARK_VALUE = 2;

export type BeamDirection = "up" | "down" | "left" | "right";
export type BeamGameStatus = "ready" | "playing" | "won" | "lost";
export type BeamSparkKind = "spark" | "rich";

export interface BeamPoint {
  x: number;
  y: number;
}

export interface BeamFood extends BeamPoint {
  kind: BeamSparkKind;
}

export interface BeamGameState {
  snake: BeamPoint[];
  food: BeamFood;
  direction: BeamDirection; // direction of the last executed step
  directionQueue: BeamDirection[]; // buffered turns, max 2 deep
  score: number;
  sparksEaten: number; // number of sparks consumed this run
  status: BeamGameStatus;
}

const START_SNAKE: BeamPoint[] = [
  { x: 5, y: 7 },
  { x: 4, y: 7 },
  { x: 3, y: 7 },
];

const MAX_QUEUED_TURNS = 2;

const OPPOSITE: Record<BeamDirection, BeamDirection> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

export function pointsEqual(a: BeamPoint, b: BeamPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

export function createInitialBeamGameState(): BeamGameState {
  return {
    snake: START_SNAKE.map((point) => ({ ...point })),
    food: { x: 10, y: 7, kind: "spark" },
    direction: "right",
    directionQueue: [],
    score: 0,
    sparksEaten: 0,
    status: "ready",
  };
}

export function turnBeamSnake(state: BeamGameState, direction: BeamDirection): BeamGameState {
  if (state.directionQueue.length >= MAX_QUEUED_TURNS) return state;
  const effective =
    state.directionQueue.length > 0
      ? state.directionQueue[state.directionQueue.length - 1]
      : state.direction;
  if (direction === effective || direction === OPPOSITE[effective]) return state;
  return { ...state, directionQueue: [...state.directionQueue, direction] };
}

function nextHead(head: BeamPoint, direction: BeamDirection): BeamPoint {
  if (direction === "up") return { x: head.x, y: head.y - 1 };
  if (direction === "down") return { x: head.x, y: head.y + 1 };
  if (direction === "left") return { x: head.x - 1, y: head.y };
  return { x: head.x + 1, y: head.y };
}

function outOfBounds(point: BeamPoint): boolean {
  return point.x < 0 || point.y < 0 || point.x >= ARENA_BEAM_BOARD_SIZE || point.y >= ARENA_BEAM_BOARD_SIZE;
}

export function nextBeamFood(snake: BeamPoint[], sparksEaten: number): BeamFood {
  const occupied = new Set(snake.map((point) => `${point.x}:${point.y}`));
  const total = ARENA_BEAM_BOARD_SIZE * ARENA_BEAM_BOARD_SIZE;
  const start = (sparksEaten * 37 + snake[0].x * 11 + snake[0].y * 17 + 19) % total;
  const kind: BeamSparkKind =
    (sparksEaten + 1) % ARENA_BEAM_RICH_SPARK_INTERVAL === 0 ? "rich" : "spark";
  for (let offset = 0; offset < total; offset += 1) {
    const index = (start + offset) % total;
    const point = { x: index % ARENA_BEAM_BOARD_SIZE, y: Math.floor(index / ARENA_BEAM_BOARD_SIZE) };
    if (!occupied.has(`${point.x}:${point.y}`)) return { ...point, kind };
  }
  return { x: 0, y: 0, kind };
}

export function stepBeamGame(state: BeamGameState): BeamGameState {
  if (state.status !== "playing") return state;

  const direction = state.directionQueue.length > 0 ? state.directionQueue[0] : state.direction;
  const directionQueue = state.directionQueue.slice(1);
  const head = nextHead(state.snake[0], direction);
  const ate = pointsEqual(head, state.food);
  const body = ate ? state.snake : state.snake.slice(0, -1);
  if (outOfBounds(head) || body.some((point) => pointsEqual(point, head))) {
    // Crashing after reaching the target is still a claimable win — never
    // punish the greed loop.
    return {
      ...state,
      direction,
      directionQueue,
      status: state.score >= ARENA_BEAM_TARGET_SCORE ? "won" : "lost",
    };
  }

  const snake = [head, ...body];
  const score = ate
    ? state.score + (state.food.kind === "rich" ? ARENA_BEAM_RICH_SPARK_VALUE : 1)
    : state.score;
  const sparksEaten = ate ? state.sparksEaten + 1 : state.sparksEaten;
  return {
    snake,
    food: ate ? nextBeamFood(snake, sparksEaten) : state.food,
    direction,
    directionQueue,
    score,
    sparksEaten,
    // Reaching the target never ends the run — play continues indefinitely
    // and beamPowerForScore caps the reward.
    status: "playing",
  };
}

export function cashOutBeamRun(state: BeamGameState): BeamGameState {
  if (state.status === "playing" && state.score >= ARENA_BEAM_TARGET_SCORE) {
    return { ...state, status: "won" };
  }
  return state;
}

export function beamPowerForScore(score: number): number {
  if (!Number.isFinite(score) || score < ARENA_BEAM_TARGET_SCORE) return 0;
  return Math.max(
    1,
    Math.min(
      ARENA_BEAM_MAX_POWER,
      Math.floor(Math.min(Math.floor(score), ARENA_BEAM_MAX_SCORE) / ARENA_BEAM_POWER_STEP),
    ),
  );
}

const TICK_START_MS = 145;
const TICK_DROP_PER_SPARK_MS = 4;
const TICK_FLOOR_MS = 85;
const REDUCED_TICK_START_MS = 210;
const REDUCED_TICK_DROP_PER_SPARK_MS = 3;
const REDUCED_TICK_FLOOR_MS = 150;

export function beamTickMs(sparksEaten: number, reducedMotion: boolean): number {
  const eaten = Math.max(0, Math.floor(sparksEaten));
  if (reducedMotion) {
    return Math.max(REDUCED_TICK_FLOOR_MS, REDUCED_TICK_START_MS - eaten * REDUCED_TICK_DROP_PER_SPARK_MS);
  }
  return Math.max(TICK_FLOOR_MS, TICK_START_MS - eaten * TICK_DROP_PER_SPARK_MS);
}
