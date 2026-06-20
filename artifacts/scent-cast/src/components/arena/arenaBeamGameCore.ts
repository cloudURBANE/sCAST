export const ARENA_BEAM_BOARD_SIZE = 14;
export const ARENA_BEAM_TARGET_SCORE = 8;

export type BeamDirection = "up" | "down" | "left" | "right";
export type BeamGameStatus = "ready" | "playing" | "won" | "lost";

export interface BeamPoint {
  x: number;
  y: number;
}

export interface BeamGameState {
  snake: BeamPoint[];
  food: BeamPoint;
  direction: BeamDirection;
  pendingDirection: BeamDirection;
  score: number;
  status: BeamGameStatus;
}

const START_SNAKE: BeamPoint[] = [
  { x: 5, y: 7 },
  { x: 4, y: 7 },
  { x: 3, y: 7 },
];

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
    food: { x: 10, y: 7 },
    direction: "right",
    pendingDirection: "right",
    score: 0,
    status: "ready",
  };
}

export function turnBeamSnake(state: BeamGameState, direction: BeamDirection): BeamGameState {
  if (OPPOSITE[state.direction] === direction) return state;
  return { ...state, pendingDirection: direction };
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

export function nextBeamFood(snake: BeamPoint[], score: number): BeamPoint {
  const occupied = new Set(snake.map((point) => `${point.x}:${point.y}`));
  const total = ARENA_BEAM_BOARD_SIZE * ARENA_BEAM_BOARD_SIZE;
  const start = (score * 37 + snake[0].x * 11 + snake[0].y * 17 + 19) % total;
  for (let offset = 0; offset < total; offset += 1) {
    const index = (start + offset) % total;
    const point = { x: index % ARENA_BEAM_BOARD_SIZE, y: Math.floor(index / ARENA_BEAM_BOARD_SIZE) };
    if (!occupied.has(`${point.x}:${point.y}`)) return point;
  }
  return { x: 0, y: 0 };
}

export function stepBeamGame(state: BeamGameState): BeamGameState {
  if (state.status !== "playing") return state;

  const direction = state.pendingDirection;
  const head = nextHead(state.snake[0], direction);
  const ate = pointsEqual(head, state.food);
  const body = ate ? state.snake : state.snake.slice(0, -1);
  if (outOfBounds(head) || body.some((point) => pointsEqual(point, head))) {
    return { ...state, direction, pendingDirection: direction, status: "lost" };
  }

  const snake = [head, ...body];
  const score = ate ? state.score + 1 : state.score;
  return {
    snake,
    food: ate ? nextBeamFood(snake, score) : state.food,
    direction,
    pendingDirection: direction,
    score,
    status: score >= ARENA_BEAM_TARGET_SCORE ? "won" : "playing",
  };
}
