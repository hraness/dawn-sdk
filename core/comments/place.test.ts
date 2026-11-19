// SPDX-License-Identifier: MIT
/** Where an anchor lands: exact, moved or lost, and never dropped. */
import { describe, expect, test } from "bun:test";
import { createScore } from "../score.ts";
import { barsInWords, placeAnchor } from "./place.ts";

const note = (
  id: string,
  trackId: string,
  startTick: number,
  durationTicks: number,
  pitch: number,
) => ({ id, trackId, startTick, durationTicks, pitch, velocity: 0.8 });

/** 8 bars at 120: a bar is 1,920 ticks and 2 seconds. */
const song = (more: Record<string, unknown> = {}) =>
  createScore({
    tempoBpm: 120,
    bars: 8,
    tracks: [
      { id: "bass", name: "Sub bass", instrument: "synth" },
      { id: "hats", name: "Hats", instrument: "drums" },
    ],
    notes: [
      note("a", "bass", 0, 480, 43),
      note("b", "bass", 7680, 480, 43),
      note("c", "bass", 8160, 240, 46),
    ],
    sections: [
      { name: "A", startBar: 0, bars: 4 },
      { name: "B", startBar: 4, bars: 4 },
    ],
    ...more,
  });
const REV = "a".repeat(43);
const OTHER = "b".repeat(43);

describe("placeAnchor", () => {
  test("no fields is the song", () => {
    const place = placeAnchor({}, song(), REV);
    expect(place).toMatchObject({
      state: "exact",
      ticks: [0, 15360],
      seconds: [0, 16],
      bars: [0, 8],
      words: "the song",
    });
  });

  test("in the revision it names, an anchor is exact, in ticks and in seconds", () => {
    const place = placeAnchor(
      { rev: REV, track: "bass", bars: [4, 6] },
      song(),
      REV,
    );
    expect(place).toEqual({
      state: "exact",
      basis: "revision",
      earlier: false,
      track: { id: "bass", name: "Sub bass" },
      ticks: [7680, 11520],
      seconds: [8, 12],
      bars: [4, 6],
      plays: [[8, 12]],
      notes: [],
      words: "Sub bass, bars 5 to 6",
    });
  });

  test("the track's name is the one it has now", () => {
    const place = placeAnchor({ rev: OTHER, track: "hats" }, song(), REV);
    expect(place.track).toEqual({ id: "hats", name: "Hats" });
    expect(place.state).toBe("exact");
    expect(place.basis).toBe("content");
    expect(place.earlier).toBe(true);
  });

  test("notes that are all still there are exact in any revision", () => {
    const place = placeAnchor(
      {
        rev: OTHER,
        track: "bass",
        notes: [
          [7680, 480, 43],
          [8160, 240, 46],
        ],
      },
      song(),
      REV,
    );
    expect(place).toMatchObject({
      state: "exact",
      basis: "content",
      ticks: [7680, 8400],
      seconds: [8, 8.75],
      bars: [4, 5],
      words: "Sub bass, bar 5, 2 notes",
    });
    expect(place.notes).toHaveLength(2);
  });

  test("some notes gone: moved, with the ones that are left", () => {
    const place = placeAnchor(
      {
        rev: OTHER,
        track: "bass",
        notes: [
          [7680, 480, 43],
          [9000, 240, 50],
        ],
      },
      song(),
      REV,
    );
    expect(place.state).toBe("moved");
    expect(place.notes).toEqual([[7680, 480, 43]]);
    expect(place.words).toContain("from an earlier version");
    expect(place.was).toMatchObject({ track: "bass", notes: 2 });
  });

  test("every note gone is lost, with the bars and names it had", () => {
    const gone = {
      rev: OTHER,
      track: "bass",
      notes: [[9000, 240, 50]],
    } as const;
    expect(placeAnchor({ ...gone, bars: [4, 5] }, song(), REV)).toMatchObject({
      state: "lost",
      basis: "nothing",
      ticks: null,
      was: { track: "bass", bars: [4, 5], notes: 1 },
    });
    const lost = placeAnchor(gone, song(), REV);
    expect(lost).toMatchObject({
      state: "lost",
      ticks: null,
      seconds: null,
      bars: null,
      plays: null,
      was: { track: "bass", notes: 1 },
    });
    expect(lost.words).toBe("on an earlier version (bass, 1 note)");
    // The track is still here, so its name still is.
    expect(lost.track).toEqual({ id: "bass", name: "Sub bass" });
  });

  test("a track or a section that is gone is lost, with the bars and names it had", () => {
    const place = placeAnchor(
      { rev: OTHER, track: "lead", section: "B", bars: [4, 8] },
      song(),
      REV,
    );
    expect(place.state).toBe("lost");
    expect(place.words).toBe(
      "on an earlier version (lead, section B, bars 5 to 8)",
    );
    expect(place.was).toEqual({ track: "lead", section: "B", bars: [4, 8] });
    expect(
      placeAnchor({ section: "Bridge", bars: [4, 8] }, song(), REV).state,
    ).toBe("lost");
  });

  test("a range past the end of the song is lost", () => {
    expect(placeAnchor({ rev: OTHER, bars: [8, 12] }, song(), REV).state).toBe(
      "lost",
    );
    // One that only runs past it is cut to the song.
    expect(
      placeAnchor({ rev: OTHER, bars: [6, 12] }, song(), REV),
    ).toMatchObject({ state: "moved", ticks: [11520, 15360] });
  });

  test("a section found by name; bars outside it now mean it moved", () => {
    expect(
      placeAnchor({ rev: OTHER, section: "b" }, song(), REV),
    ).toMatchObject({
      state: "exact",
      section: { name: "B", startBar: 4, bars: 4 },
      ticks: [7680, 15360],
      words: "section B",
    });
    expect(
      placeAnchor({ rev: OTHER, section: "B", bars: [5, 7] }, song(), REV)
        .state,
    ).toBe("exact");
    const moved = placeAnchor(
      { rev: OTHER, section: "B", bars: [2, 4] },
      song(),
      REV,
    );
    expect(moved).toMatchObject({ state: "moved", ticks: [7680, 15360] });
  });

  test("bars with no revision are shown and not claimed", () => {
    const place = placeAnchor({ bars: [2, 4] }, song(), REV);
    expect(place).toMatchObject({
      state: "moved",
      basis: "bars",
      earlier: false,
      words: "bars 3 to 4, version not recorded",
    });
  });

  test("names kept from an older file are reported", () => {
    const place = placeAnchor(
      {
        bars: [2, 4],
        was: {
          tracks: [
            { id: "kick", name: "Kick" },
            { id: "bass", name: "Bass" },
          ],
          sections: ["A", "B"],
        },
      },
      song(),
      REV,
    );
    expect(place.was?.names).toEqual(["Kick", "Bass", "A", "B"]);
  });

  test("plays: once for each time the form plays the range", () => {
    const formed = song({
      form: [{ section: "A" }, { section: "B", repeat: 2 }, { section: "A" }],
    });
    const place = placeAnchor({ rev: REV, bars: [4, 5] }, formed, REV);
    expect(place.seconds).toEqual([8, 10]);
    expect(place.plays).toEqual([
      [8, 10],
      [16, 18],
    ]);
    const first = placeAnchor({ rev: REV, bars: [0, 1] }, formed, REV);
    expect(first.plays).toEqual([
      [0, 2],
      [24, 26],
    ]);
  });

  test("seconds follow a tempo map", () => {
    const mapped = song({
      time: { tempo: [{ tick: 7680, bpm: 60 }] },
    });
    const place = placeAnchor({ rev: REV, bars: [4, 5] }, mapped, REV);
    expect(place.seconds).toEqual([8, 12]);
  });

  test("bars in words count from 1", () => {
    expect(barsInWords([0, 1])).toBe("bar 1");
    expect(barsInWords([8, 12])).toBe("bars 9 to 12");
  });
});
