// SPDX-License-Identifier: MIT
/** A small hand-made score for the link tests: every kind of thing a link carries. */
import { createScore, type TrackScore } from "../score.ts";

export function fixtureScore(): TrackScore {
  return createScore({
    tempoBpm: 96,
    bars: 2,
    key: "D minor",
    tracks: [
      { id: "lead", name: "Caf\u{e9} lead", instrument: "synth", volume: 0.62 },
      { id: "kick", name: "Kick", instrument: "drums", pan: -0.25 },
      { id: "rest", name: "Nothing yet", instrument: "synth" },
    ],
    notes: [
      // Two notes at one time and pitch: their order is the writer's.
      n("b", "lead", 0, 480, 62, 0.8),
      n("a", "lead", 0, 240, 62, 0.4),
      { ...n("c", "lead", 480, 240, 65, 0.725), cents: 14 },
      // A velocity that is not a whole number of thousandths.
      n("d", "lead", 960, 240, 69, 1 / 3),
      n("k1", "kick", 0, 120, 36, 1),
      n("k2", "kick", 480, 120, 36, 0.9),
    ],
    master: { limiter: { ceiling: -1.5 } },
  });
}

function n(
  id: string,
  trackId: string,
  startTick: number,
  durationTicks: number,
  pitch: number,
  velocity: number,
) {
  return { id, trackId, startTick, durationTicks, pitch, velocity };
}
