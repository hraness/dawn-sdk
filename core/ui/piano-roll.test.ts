// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { SCORE_LIMITS } from "../score.ts";
import {
  MAX_PIANO_ROLL_BEATS,
  pianoRollLayout,
  scoreContourPath,
} from "./piano-roll.ts";

const note = { pitch: 60, velocity: 0.5, startTick: 7, durationTicks: 48 };
const options = { notes: [note], bars: 2, beatsPerBar: 3, ticksPerBeat: 96 };

test("placing and dragging use the same score coordinates, retain microtiming and support odd meter", () => {
  const roll = pianoRollLayout(options);
  expect(roll.beats).toBe(6);
  expect(roll.length).toBe(576);
  expect(roll.rows).toBe(13);
  expect(roll.point(0.2, 0.5)).toEqual({ startTick: 96, pitch: 60 });
  expect(roll.drag(note, 1 / 6, -1 / 13, "move")).toEqual({
    ...note,
    startTick: 103,
    pitch: 61,
  });
  expect(roll.drag(note, -20, 20, "move")).toEqual({
    ...note,
    startTick: 0,
    pitch: 54,
  });
  const last = { ...note, startTick: 570, durationTicks: 3 };
  expect(roll.drag(last, 1, 1, "resize")).toEqual({
    ...last,
    durationTicks: 6,
  });
  expect(roll.point(1, 1)).toEqual({ startTick: 552, pitch: 54 });
});

test("an empty grid fits middle C and short tick resolutions cannot create fractional score ticks", () => {
  const roll = pianoRollLayout({ ...options, notes: [], ticksPerBeat: 1 });
  expect([roll.lowest, roll.highest, roll.step]).toEqual([54, 66, 1]);
  expect(roll.point(0.8, 0).startTick).toBe(4);
  const pitched = pianoRollLayout({
    ...options,
    notes: [
      { ...note, pitch: 0 },
      { ...note, pitch: 127 },
    ],
  });
  expect([pitched.lowest, pitched.highest]).toEqual([0, 127]);
});

test("texture movement adjusts intensity without transposing the sound", () => {
  const roll = pianoRollLayout({ ...options, mode: "velocity" });
  expect(roll.rowOf(note)).toBe(4);
  expect(roll.drag(note, 0, -1 / 9, "move")).toEqual({
    ...note,
    velocity: 0.625,
  });
  expect(roll.drag(note, 0, 5, "move").velocity).toBe(0.01);
  const quiet = { ...note, velocity: 0 };
  expect(roll.drag(quiet, 0, 0, "move")).toEqual(quiet);
});

test("timing and pitches are bounded before constructing any DOM", () => {
  expect(MAX_PIANO_ROLL_BEATS).toBe(
    SCORE_LIMITS.maxBars * SCORE_LIMITS.maxBeatsPerBar,
  );
  expect(() => pianoRollLayout({ ...options, bars: 0 })).toThrow(RangeError);
  expect(() => pianoRollLayout({ ...options, bars: 10 ** 9 })).toThrow(
    RangeError,
  );
  expect(() => pianoRollLayout({ ...options, beatsPerBar: NaN })).toThrow(
    RangeError,
  );
  expect(() => pianoRollLayout({ ...options, snapTicks: 0.5 })).toThrow(
    RangeError,
  );
  expect(() =>
    pianoRollLayout({ ...options, notes: [{ ...note, pitch: Infinity }] }),
  ).toThrow(RangeError);
  expect(() =>
    pianoRollLayout({ ...options, notes: [{ ...note, velocity: NaN }] }),
  ).toThrow(RangeError);
});

test("miniatures show duration, pitch or velocity, clipped to the visible passage", () => {
  const dims = { length: 100, width: 102, height: 24 };
  const a = { ...note, startTick: 0, durationTicks: 15 };
  const b = {
    ...a,
    startTick: 90,
    pitch: 72,
    velocity: 0.25,
    durationTicks: 35,
  };
  expect(scoreContourPath([], dims)).toBe("");
  expect(scoreContourPath([a, b], dims)).toBe(
    "M1.00 22.00h15.00 M91.00 2.00h10.00",
  );
  expect(scoreContourPath([a, b], { ...dims, mode: "velocity" })).toBe(
    "M1.00 2.00h15.00 M91.00 22.00h10.00",
  );
  expect(scoreContourPath([a], dims)).toBe("M1.00 12.00h15.00");
  expect(scoreContourPath([{ ...b, startTick: 150 }], dims)).toBe("");
});
