import assert from "node:assert/strict";
import test from "node:test";
import {
  ARENA_BEAM_TARGET_SCORE,
  createInitialBeamGameState,
  stepBeamGame,
  turnBeamSnake,
  type BeamGameState,
} from "./arenaBeamGameCore.ts";

test("stepBeamGame moves the snake in the current direction", () => {
  const state = { ...createInitialBeamGameState(), status: "playing" as const };
  const next = stepBeamGame(state);
  assert.deepEqual(next.snake[0], { x: 6, y: 7 });
  assert.equal(next.score, 0);
});

test("stepBeamGame grows and scores when it reaches food", () => {
  const state: BeamGameState = {
    ...createInitialBeamGameState(),
    status: "playing",
    snake: [{ x: 9, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 7 }],
    food: { x: 10, y: 7 },
  };
  const next = stepBeamGame(state);
  assert.equal(next.score, 1);
  assert.equal(next.snake.length, 4);
});

test("turnBeamSnake rejects direct reverse turns", () => {
  const state = { ...createInitialBeamGameState(), status: "playing" as const };
  assert.equal(turnBeamSnake(state, "left").pendingDirection, "right");
  assert.equal(turnBeamSnake(state, "up").pendingDirection, "up");
});

test("stepBeamGame detects wall and self collisions", () => {
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
      pendingDirection: "down",
      snake: [
        { x: 5, y: 5 },
        { x: 5, y: 6 },
        { x: 4, y: 6 },
        { x: 4, y: 5 },
      ],
      food: { x: 9, y: 9 },
    }).status,
    "lost",
  );
});

test("stepBeamGame marks the run won at the target score", () => {
  const state: BeamGameState = {
    ...createInitialBeamGameState(),
    status: "playing",
    score: ARENA_BEAM_TARGET_SCORE - 1,
    snake: [{ x: 9, y: 7 }, { x: 8, y: 7 }, { x: 7, y: 7 }],
    food: { x: 10, y: 7 },
  };
  assert.equal(stepBeamGame(state).status, "won");
});
