/**
 * Euclid Pulse, an example DAWN composer plug-in (MIT, examples/LICENSE).
 *
 * It runs in DAWN's sealed song engine: no files, network, clock or
 * `Math.random`. Every choice comes from `brief.seed` through
 * `seededRandom`, so the same brief always gives the same song.
 */
import {
  composer,
  euclid,
  grid,
  note,
  progression,
  seededRandom,
  song,
  track,
  type ComposerBrief,
  type ComposerSoundRole,
  type NoteSpec,
  type SongSection,
} from "dawn";
import { LOOPS, type Mode } from "./loops.ts";

const PENTATONIC: Record<Mode, readonly number[]> = {
  minor: [0, 3, 5, 7, 10],
  major: [0, 2, 4, 7, 9],
};
const ROOTS = ["C", "D", "E", "F", "G", "A", "B"] as const;
const PITCH: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** The mode the brief asks for: its key, then its words, then the seed. */
function modeOf(brief: ComposerBrief, random: () => number): Mode {
  const words =
    `${brief.key ?? ""} ${brief.mood ?? ""} ${brief.prompt}`.toLowerCase();
  if (/\b(minor|dark|sad|night|cold|moody)\b/.test(words)) return "minor";
  if (/\b(major|bright|happy|sunny|warm|joy)\b/.test(words)) return "major";
  return random() < 0.6 ? "minor" : "major";
}

/** Sections in bar order, from the brief's form or one loop of `bars`. */
function sectionsOf(brief: ComposerBrief, bars: number): SongSection[] {
  if (!brief.form) return [];
  const seen = new Map<string, number>();
  let start = 0;
  return brief.form
    .map((s) => {
      const n = (seen.get(s.name) ?? 0) + 1;
      seen.set(s.name, n);
      const section = {
        name: n > 1 ? `${s.name} ${n}` : s.name,
        startBar: start,
        bars: s.bars,
      };
      start += s.bars;
      return section;
    })
    .filter((s) => s.startBar < bars);
}

export default composer((brief) => {
  const random = seededRandom(brief.seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)]!;
  const base = brief.score;
  const mode = modeOf(brief, random);
  const key = brief.key ?? base?.key ?? `${pick(ROOTS)} ${mode}`;
  const tonic =
    PITCH[key[0]!.toUpperCase()]! +
    (key[1] === "#" ? 1 : key[1] === "b" ? -1 : 0);
  const energy = brief.energy ?? 0.4 + random() * 0.4;
  const tempo =
    brief.tempo ??
    base?.tempoBpm ??
    Math.round(88 + energy * 40 + random() * 8);
  const formBars = brief.form?.reduce((n, s) => n + s.bars, 0);
  const bars = brief.bars ?? formBars ?? base?.bars ?? 8;
  const loop = pick(LOOPS[mode]);
  const chords = Array.from({ length: bars }, (_, i) => loop[i % loop.length]!);

  // Drums: Euclidean rows whose density follows the energy.
  const kicks = 2 + Math.round(energy * 3);
  const hats = 5 + Math.round(energy * 6);
  const drums = track({
    name: "Drums",
    instrument: "kit",
    rhythm: [
      euclid("kick", kicks, 16, { velocity: 0.9, seed: brief.seed % 1000000 }),
      grid("snare", "....x.......x..."),
      euclid("hat", hats, 16, Math.floor(random() * 4), {
        velocity: 0.45,
        accent: 0.5,
        accents: 3,
        probability: 0.85,
        seed: (brief.seed >>> 3) % 1000000,
      }),
    ],
  });

  // Keys: the loop, one chord a bar, voice-led.
  const keys = track({
    name: "Keys",
    instrument: "piano",
    volume: 0.7,
    notes: progression(chords, { key, each: 4, vel: 0.55 }),
  });

  // Bass: each chord's root on a Euclidean pattern of eighths.
  const bassPulses = 3 + Math.round(energy * 2);
  const onsets = Array.from({ length: 8 }, (_, i) => i).filter(
    (i) =>
      Math.floor((i * bassPulses) / 8) !==
      Math.floor(((i - 1) * bassPulses) / 8),
  );
  const bassNotes: NoteSpec[] = [];
  chords.forEach((_, bar) => {
    const root = progression([chords[bar]!], { key, part: "bass" })[0]!.pitch;
    for (const i of onsets)
      bassNotes.push(note(root, bar * 4 + i * 0.5, 0.45, 0.8));
  });
  const bass = track({ name: "Bass", instrument: "bass", notes: bassNotes });

  // Lead: a pentatonic walk on an off-grid Euclidean rhythm, resting in the
  // first bar of each section so the form breathes.
  const scale = PENTATONIC[mode];
  const leadNotes: NoteSpec[] = [];
  const steps = 3 + Math.round(energy * 4);
  let degree = Math.floor(random() * scale.length);
  for (let bar = 0; bar < bars; bar++) {
    if (bar % 8 === 0) continue;
    for (let i = 0; i < steps; i++) {
      const at = bar * 4 + Math.floor((i * 16) / steps) * 0.25;
      degree = Math.max(
        0,
        Math.min(scale.length * 2 - 1, degree + pick([-2, -1, 1, 1, 2])),
      );
      const pitch =
        72 +
        tonic +
        scale[degree % scale.length]! +
        12 * Math.floor(degree / scale.length) -
        12;
      leadNotes.push(
        note(
          pitch,
          at,
          0.25 * (1 + Math.floor(random() * 3)),
          0.6 + random() * 0.25,
        ),
      );
    }
  }
  const lead = track({
    name: "Lead",
    instrument: "pluck",
    volume: 0.6,
    notes: leadNotes,
  });

  // Palette voices: the first offered sound of each part's role.
  const voices: Record<string, string> = {};
  const voice = (id: string, role: ComposerSoundRole) => {
    const sound = brief.sounds.find((s) => s.role === role);
    if (sound) voices[id] = sound.id;
  };
  voice("keys", "keys");
  voice("bass", "bass");
  voice("lead", "lead");

  const sections = sectionsOf(brief, bars);
  return {
    song: song({
      tempo,
      key,
      bars,
      tracks: [drums, bass, keys, lead],
      ...(sections.length ? { sections } : {}),
    }),
    voices,
    summary: `${loop.join(" ")} in ${key} · ${tempo} BPM · ${bars} bars · kick E(${kicks},16) · hat E(${hats},16)`,
  };
});
