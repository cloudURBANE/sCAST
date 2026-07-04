import assert from "node:assert/strict";
import test from "node:test";
import {
  ARENA_BEAM_RICH_SPARK_INTERVAL,
  ARENA_BEAM_RICH_SPARK_VALUE,
  ARENA_BEAM_TARGET_SCORE,
  beamPowerForScore,
  beamTickMs,
  cashOutBeamRun,
  createInitialBeamGameState,
  nextBeamFood,
  pointsEqual,
  stepBeamGame,
  turnBeamSnake,
  type BeamGameState,
} from "./arenaBeamGameCore.ts";

test("createInitialBeamGameState starts ready with a plain spark", () => {
  const state = createInitialBeamGameState();
  assert.deepEqual(state.snake, [{ x: 5, y: 7 }, { x: 4, y: 7 }, { x: 3, y: 7 }]);
  assert.deepEqual(state.food, { x: 10, y: 7, kind: "spark" });
  assert.equal(state.direction, "right");
  assert.deepEqual(state.directionQueue, []);
  assert.equal(state.score, 0);
  assert.equal(state.sparksEaten, 0);
  assert.equal(state.status, "ready");
});

test("stepBeamGame moves the snake in the current direction", () => {
  const state = { ...createInitialBeamGameState(), status: "playing" as const };
  const next = stepBeamGame(state);
  assert.deepEqual(next.snake[0], { x: 6, y: 7 });
  assert.equal(next.score, 0);
  assert.equal(next.sparksEaten, 0);
});

test("stepBeamGame is a no-op unless playing", () => {
  const ready = createInitialBeamGameState();
  assert.equal(stepBeamGame(ready), ready);
  const lost = { ...ready, status: "lost" as const };
  assert.equal(stepBeamGame(lost), lost);
});

test("stepBeamGame grows and scores when it reaches food", () => {
  const state: BeamGameState = {
    ...createInitialBeamGameState(),
    status: "playing",
    snake: [{ x: 9, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 7 }],
    food: { x: 10, y: 7, kind: "spark" },
  };
  const next = stepBeamGame(state);
  assert.equal(next.score, 1);
  assert.equal(next.sparksEaten, 1);
  assert.equal(next.snake.length, 4);
});

test("rich sparks are worth 2 points but still grow the snake by 1", () => {
  const state: BeamGameState = {
    ...createInitialBeamGameState(),
    status: "playing",
    snake: [{ x: 9, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 7 }],
    food: { x: 10, y: 7, kind: "rich" },
    score: 5,
    sparksEaten: 3,
  };
  const next = stepBeamGame(state);
  assert.equal(next.score, 5 + ARENA_BEAM_RICH_SPARK_VALUE);
  assert.equal(next.sparksEaten, 4);
  assert.equal(next.snake.length, 4);
});

test("every 4th spark to be eaten is placed as rich", () => {
  const snake = [{ x: 0, y: 0 }];
  assert.equal(nextBeamFood(snake, 0).kind, "spark");
  assert.equal(nextBeamFood(snake, 1).kind, "spark");
  assert.equal(nextBeamFood(snake, 2).kind, "spark");
  assert.equal(nextBeamFood(snake, ARENA_BEAM_RICH_SPARK_INTERVAL - 1).kind, "rich");
  assert.equal(nextBeamFood(snake, ARENA_BEAM_RICH_SPARK_INTERVAL).kind, "spark");
  assert.equal(nextBeamFood(snake, 2 * ARENA_BEAM_RICH_SPARK_INTERVAL - 1).kind, "rich");

  // Via gameplay: eating the 3rd spark places the 4th, which is rich.
  const state: BeamGameState = {
    ...createInitialBeamGameState(),
    status: "playing",
    snake: [{ x: 9, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 7 }],
    food: { x: 10, y: 7, kind: "spark" },
    score: 2,
    sparksEaten: 2,
  };
  assert.equal(stepBeamGame(state).food.kind, "rich");
});

test("nextBeamFood is deterministic and never lands on the snake", () => {
  const snake = [
    { x: 6, y: 7 },
    { x: 5, y: 7 },
    { x: 4, y: 7 },
    { x: 3, y: 7 },
  ];
  const first = nextBeamFood(snake, 5);
  const second = nextBeamFood(snake, 5);
  assert.deepEqual(first, second);
  assert.equal(snake.some((point) => pointsEqual(point, first)), false);
});

test("turnBeamSnake buffers up to two turns that both execute", () => {
  let state = { ...createInitialBeamGameState(), status: "playing" as const };
  state = turnBeamSnake(state, "up");
  state = turnBeamSnake(state, "left");
  assert.deepEqual(state.directionQueue, ["up", "left"]);

  state = stepBeamGame(state);
  assert.equal(state.direction, "up");
  assert.deepEqual(state.snake[0], { x: 5, y: 6 });
  assert.deepEqual(state.directionQueue, ["left"]);

  state = stepBeamGame(state);
  assert.equal(state.direction, "left");
  assert.deepEqual(state.snake[0], { x: 4, y: 6 });
  assert.deepEqual(state.directionQueue, []);
});

test("turnBeamSnake rejects reverse and no-op turns against the queue tail", () => {
  const base = { ...createInitialBeamGameState(), status: "playing" as const };
  // Against state.direction when the queue is empty.
  assert.deepEqual(turnBeamSnake(base, "left").directionQueue, []);
  assert.deepEqual(turnBeamSnake(base, "right").directionQueue, []);

  const queued = turnBeamSnake(base, "up");
  assert.deepEqual(queued.directionQueue, ["up"]);
  // "down" reverses the queued "up"; "up" repeats it. Both are rejected.
  assert.equal(turnBeamSnake(queued, "down"), queued);
  assert.equal(turnBeamSnake(queued, "up"), queued);
});

test("turnBeamSnake caps the queue at two buffered turns", () => {
  let state = { ...createInitialBeamGameState(), status: "playing" as const };
  state = turnBeamSnake(state, "up");
  state = turnBeamSnake(state, "left");
  // "down" is a legal turn off "left", but the queue is full.
  assert.equal(turnBeamSnake(state, "down"), state);
  assert.deepEqual(state.directionQueue, ["up", "left"]);
});

test("turnBeamSnake works before the run starts", () => {
  const state = createInitialBeamGameState();
  assert.equal(state.status, "ready");
  assert.deepEqual(turnBeamSnake(state, "up").directionQueue, ["up"]);
});

test("stepBeamGame detects wall and self collisions as lost below the target", () => {
  assert.equal(
    stepBeamGame({
      ...createInitialBeamGameState(),
      status: "playing",
      snake: [{ x: 13, y: 7 }, { x: 12, y: 7 }],
    }).status,
    "lost",
  );

  assert.equal(
    stepBeamGame({
      ...createInitialBeamGameState(),
      status: "playing",
      direction: "right",
      directionQueue: ["down"],
      snake: [
        { x: 5, y: 5 },
        { x: 5, y: 6 },
        { x: 4, y: 6 },
        { x: 4, y: 5 },
      ],
      food: { x: 9, y: 9, kind: "spark" },
    }).status,
    "lost",
  );
});

test("reaching the target score keeps the run playing", () => {
  const state: BeamGameState = {
    ...createInitialBeamGameState(),
    status: "playing",
    score: ARENA_BEAM_TARGET_SCORE - 1,
    sparksEaten: 6,
    snake: [{ x: 9, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 7 }],
    food: { x: 10, y: 7, kind: "spark" },
  };
  const next = stepBeamGame(state);
  assert.equal(next.score, ARENA_BEAM_TARGET_SCORE);
  assert.equal(next.status, "playing");
});

test("crashing after reaching the target ends the run as won", () => {
  const next = stepBeamGame({
    ...createInitialBeamGameState(),
    status: "playing",
    score: ARENA_BEAM_TARGET_SCORE + 4,
    sparksEaten: 10,
    snake: [{ x: 13, y: 7 }, { x: 12, y: 7 }, { x: 11, y: 7 }],
  });
  assert.equal(next.status, "won");
  assert.equal(next.score, ARENA_BEAM_TARGET_SCORE + 4);
});

test("cashOutBeamRun claims a playing run at or past the target", () => {
  const claimable: BeamGameState = {
    ...createInitialBeamGameState(),
    status: "playing",
    score: ARENA_BEAM_TARGET_SCORE,
  };
  assert.equal(cashOutBeamRun(claimable).status, "won");

  const early: BeamGameState = {
    ...createInitialBeamGameState(),
    status: "playing",
    score: ARENA_BEAM_TARGET_SCORE - 1,
  };
  assert.equal(cashOutBeamRun(early), early);

  const lost: BeamGameState = {
    ...createInitialBeamGameState(),
    status: "lost",
    score: ARENA_BEAM_TARGET_SCORE + 2,
  };
  assert.equal(cashOutBeamRun(lost), lost);
});

test("beamPowerForScore mirrors the server reward contract", () => {
  assert.equal(beamPowerForScore(0), 0);
  assert.equal(beamPowerForScore(7), 0);
  assert.equal(beamPowerForScore(8), 2); // floor(8/4)
  assert.equal(beamPowerForScore(11), 2);
  assert.equal(beamPowerForScore(12), 3);
  assert.equal(beamPowerForScore(119), 29);
  assert.equal(beamPowerForScore(120), 30);
  assert.equal(beamPowerForScore(240), 30);
  assert.equal(beamPowerForScore(999), 30);
});

test("beamTickMs ramps down monotonically to its floor", () => {
  assert.equal(beamTickMs(0, false), 145);
  assert.equal(beamTickMs(0, true), 210);

  for (const reducedMotion of [false, true]) {
    let previous = beamTickMs(0, reducedMotion);
    for (let eaten = 1; eaten <= 80; eaten += 1) {
      const current = beamTickMs(eaten, reducedMotion);
      assert.ok(current <= previous, `tick must not increase at ${eaten} sparks`);
      previous = current;
    }
  }

  assert.equal(beamTickMs(80, false), 85);
  assert.equal(beamTickMs(500, false), 85);
  assert.equal(beamTickMs(80, true), 150);
  assert.equal(beamTickMs(500, true), 150);
});
