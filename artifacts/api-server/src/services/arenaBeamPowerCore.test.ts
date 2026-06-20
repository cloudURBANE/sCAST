import assert from "node:assert/strict";
import test from "node:test";
import {
  ARENA_BEAM_MAX_POWER,
  ARENA_BEAM_MAX_SCORE,
  ARENA_BEAM_MIN_SCORE,
  cleanArenaBeamRunId,
  scoreArenaBeamRun,
} from "./arenaBeamPowerCore.ts";

test("scoreArenaBeamRun rejects non-numeric and below-target scores", () => {
  assert.deepEqual(scoreArenaBeamRun("12"), { ok: false, error: "score must be a number" });
  assert.deepEqual(scoreArenaBeamRun(ARENA_BEAM_MIN_SCORE - 1), {
    ok: false,
    error: `score must be at least ${ARENA_BEAM_MIN_SCORE}`,
  });
});

test("scoreArenaBeamRun derives bounded beam power from score", () => {
  assert.deepEqual(scoreArenaBeamRun(ARENA_BEAM_MIN_SCORE), { ok: true, score: 8, beamPower: 2 });
  assert.deepEqual(scoreArenaBeamRun(17.9), { ok: true, score: 17, beamPower: 4 });
  assert.deepEqual(scoreArenaBeamRun(999), {
    ok: true,
    score: ARENA_BEAM_MAX_SCORE,
    beamPower: ARENA_BEAM_MAX_POWER,
  });
});

test("cleanArenaBeamRunId accepts compact ids and rejects unsafe values", () => {
  assert.equal(cleanArenaBeamRunId(" run_123456 "), "run_123456");
  assert.equal(cleanArenaBeamRunId("short"), null);
  assert.equal(cleanArenaBeamRunId("bad id with spaces"), null);
});
