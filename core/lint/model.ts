// SPDX-License-Identifier: MIT
/**
 * The song as the lint rules read it: every sounding pitched note at its
 * sounding pitch, the sung lines (from note lyrics or from vocal books
 * placed by their sampler hits), the bar's chord and key, and each bar's
 * section kind. Built once per song from score JSON, so every rule is a
 * pure pass over plain arrays.
 */
import { chordPitchClasses, parseChord, parseKey, scaleOf } from "../chords.ts";
import type {
  BookStress,
  LintAllow,
  LintChord,
  LintConfig,
  VocalBooks,
} from "./types.ts";

export type ScoreTrack = Readonly<{
  id: string;
  instrument?: string;
  muted?: boolean;
  kit?: string;
  transpose?: number;
  patch?: unknown;
  synth?: Readonly<Record<string, number>>;
  sampler?: Readonly<{
    mode: "oneshot" | "keyed";
    voices: Readonly<
      Record<
        string,
        Readonly<{
          src: string;
          root?: number;
          shift?: number;
          speed?: number;
          accelerate?: number;
          squiz?: number;
          begin?: number;
          end?: number;
        }>
      >
    >;
  }>;
  volumeAutomation?: readonly unknown[];
  panAutomation?: readonly unknown[];
  fxAutomation?: Readonly<Record<string, readonly unknown[]>>;
  [k: string]: unknown;
}>;
export type ScoreNote = Readonly<{
  trackId: string;
  startTick: number;
  durationTicks: number;
  pitch: number;
  velocity?: number;
  cents?: number;
  lyric?: string;
  bend?: readonly Readonly<{ at: number; cents: number }>[];
}>;
export type ScoreJson = Readonly<{
  tempoBpm: number;
  beatsPerBar?: number;
  ticksPerBeat: number;
  bars?: number;
  key?: string | null;
  tracks: readonly ScoreTrack[];
  notes: readonly ScoreNote[];
  sections?: readonly Readonly<{
    name: string;
    startBar: number;
    bars: number;
  }>[];
}>;

/** One sounding pitched note. */
export type Sounding = {
  track: string;
  tick: number;
  ticks: number;
  pitch: number;
  cents: number;
  velocity: number;
  /** Sung (a lyric note or a book note). */
  sung?: boolean;
  /** Sung syllable text (`hel-`, `lo`, `~` for a melisma note). */
  syl?: string;
  stress?: BookStress;
  /** The sung line this note belongs to. */
  line?: string;
};

export type SungLine = {
  /** Unique: `<track>:<part>@<bar>`. */
  id: string;
  track: string;
  /** Book part name (or `line<n>` for lyric notes). */
  part: string;
  notes: Sounding[];
};

export type SectionKind =
  | "intro"
  | "verse"
  | "pre"
  | "chorus"
  | "post"
  | "bridge"
  | "break"
  | "outro"
  | "other";

export type BarSection = Readonly<{
  name: string;
  kind: SectionKind;
  start: number;
  bars: number;
}>;

export type SongModel = Readonly<{
  id: string;
  json: ScoreJson;
  tpb: number;
  bpb: number;
  tpBar: number;
  bars: number;
  bpm: number;
  /** Seconds per beat. */
  spb: number;
  key: string;
  notes: Sounding[];
  /** Every sung note (books and lyrics), lead and backing. */
  sung: Sounding[];
  lines: SungLine[];
  /** Ids of the lead vocal tracks. */
  lead: ReadonlySet<string>;
  sections: readonly BarSection[];
  sectionAt: (bar: number) => BarSection | undefined;
  /** The bar's chord: declared in the config, else inferred from the bed. */
  chordAt: (bar: number) => LintChord | undefined;
  /** True when the chords come from the config. */
  declaredHarmony: boolean;
  keyAt: (bar: number) => string;
  scaleAt: (bar: number) => ReadonlySet<number>;
  config: LintConfig;
  /** Tracks without pitch (drums, noise, fx). */
  unpitched: ReadonlySet<string>;
  /** Off-grid issues found while flattening (synth spreads, sampler speeds). */
  tuning: { track: string; detail: string; cents: number }[];
}>;

/** Tracks with no pitch: drums, noise risers, impacts, sub drops. */
const UNPITCHED_ID =
  /^(kick|snare|clap|hats?|perc|shak|tamb|rim|tom|crash|ride|cym|riser|drop|noise|sweep|impact|tear|fx|whoosh|vinyl|crackle|room|tape)/;
const UNPITCHED_PATCH = /noise|riser|sub-drop|impact|sweep|whoosh|crash|kit/;
const DRUM_INSTRUMENTS = /^(kit|drums?|808|909|tr-?\d+)$/;

export const PC_NAMES = [
  "C",
  "Db",
  "D",
  "Eb",
  "E",
  "F",
  "Gb",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
] as const;
const NAMES: Readonly<Record<string, number>> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};
export const mod12 = (n: number) => ((n % 12) + 12) % 12;
export const pcName = (pc: number) => PC_NAMES[mod12(pc)]!;
export function pcOf(name: string): number {
  const pc = NAMES[name];
  if (pc === undefined) throw new Error(`lint: unknown pitch class ${name}`);
  return pc;
}

/** The key's scale pitch classes: `Ab`, `Fm`, `A# major`, `F# dorian`. */
export function keyScale(key: string): readonly number[] {
  const m = /^([A-G][b#]?)(m?)$/.exec(key.trim());
  if (m) {
    const tonic = NAMES[m[1]!]!;
    const steps = m[2] ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    return steps.map((i) => (tonic + i) % 12);
  }
  const parsed = parseKey(key);
  if (!parsed) throw new Error(`lint: unknown key ${key}`);
  return scaleOf(parsed);
}

export function isUnpitched(track: ScoreTrack): boolean {
  if (track.kit || DRUM_INSTRUMENTS.test(String(track.instrument ?? "")))
    return true;
  if (UNPITCHED_ID.test(track.id)) return true;
  return UNPITCHED_PATCH.test(JSON.stringify(track.patch ?? ""));
}

export function sectionKind(name: string): SectionKind {
  const n = name.toLowerCase();
  if (/pre/.test(n)) return "pre";
  if (/post/.test(n)) return "post";
  if (/chorus|hook|refrain|drop/.test(n)) return "chorus";
  if (/verse|^v\d/.test(n)) return "verse";
  if (/bridge|middle/.test(n)) return "bridge";
  if (/intro/.test(n)) return "intro";
  if (/outro|coda|end/.test(n)) return "outro";
  if (/break|inst|interlude|fake|build|thesis/.test(n)) return "break";
  return "other";
}

function chordOf(value: string | LintChord | null | undefined) {
  if (!value) return undefined;
  if (typeof value !== "string") return value;
  const chord = parseChord(value);
  if (!chord) throw new Error(`lint: unknown chord ${value}`);
  return {
    bass: chord.bass ?? chord.root,
    tones: chordPitchClasses(chord),
  } satisfies LintChord;
}

export const allowMatches = (
  allow: LintAllow,
  rule: string,
  track: string | undefined,
  bar: number | undefined,
): boolean => {
  // Unscoped entries are key allowances: the key and harmony rules.
  const scopes = allow.rule === undefined ? ["key", "harmony"] : [allow.rule];
  if (!scopes.some((s) => rule === s || rule.startsWith(`${s}.`))) return false;
  if (allow.track !== undefined) {
    if (track === undefined || !new RegExp(`^(${allow.track})$`).test(track))
      return false;
  }
  if (allow.bars && bar !== undefined)
    if (bar < allow.bars[0] || bar >= allow.bars[1]) return false;
  return true;
};

/** Every sounding pitched note of the score's own (non-book) tracks. */
function flatten(
  json: ScoreJson,
  unpitched: ReadonlySet<string>,
  detuneOk: number,
  centsOk: number,
): { notes: Sounding[]; tuning: SongModel["tuning"] } {
  const notes: Sounding[] = [];
  const tuning: SongModel["tuning"] = [];
  const byTrack = new Map(json.tracks.map((t) => [t.id, t]));
  for (const n of json.notes) {
    const track = byTrack.get(n.trackId);
    if (!track || track.muted || unpitched.has(track.id)) continue;
    const sampler = track.sampler;
    if (sampler?.mode === "oneshot") continue; // book lines: see placeBooks
    let pitch = n.pitch + Number(track.transpose ?? 0);
    let cents = Number(n.cents ?? 0);
    if (sampler) {
      // Keyed: the voice whose root is the highest at or below the pitch.
      const voices = Object.values(sampler.voices).sort(
        (a, b) => (a.root ?? 60) - (b.root ?? 60),
      );
      let ref = voices[0];
      if (!ref) continue;
      for (const v of voices) if ((v.root ?? 60) <= n.pitch) ref = v;
      if (ref.accelerate || ref.squiz) continue; // a tape stop is a sweep
      if (/drum|kit|perc|kick|snare|hat|clap|noise/.test(ref.src)) continue;
      pitch += Number(ref.shift ?? 0);
      cents += 1200 * Math.log2(Math.abs(Number(ref.speed ?? 1)));
    }
    const bend = n.bend;
    if (bend?.length) cents += bend[bend.length - 1]!.cents;
    const whole = Math.round(cents / 100);
    const out: Sounding = {
      track: n.trackId,
      tick: n.startTick,
      ticks: n.durationTicks,
      pitch: pitch + whole,
      cents: cents - whole * 100,
      velocity: n.velocity ?? 0.8,
    };
    if (n.lyric !== undefined) {
      out.sung = true;
      out.syl = n.lyric === "_" ? "~" : n.lyric;
    }
    notes.push(out);
  }
  for (const track of json.tracks) {
    const syn = track.synth;
    if (track.muted || !syn || unpitched.has(track.id)) continue;
    if ((syn.unison ?? 1) > 1 && (syn.detune ?? 0) > (2 * detuneOk) / 100)
      tuning.push({
        track: track.id,
        cents: (syn.detune! / 2) * 100,
        detail: `unison detune ${syn.detune} st spreads ±${((syn.detune! / 2) * 100).toFixed(0)} cents`,
      });
    if ((syn.vib ?? 0) > 0 && (syn.vibmod ?? 0.5) > 0.6)
      tuning.push({
        track: track.id,
        cents: (syn.vibmod ?? 0.5) * 100,
        detail: `vibrato ${syn.vibmod} st deep, ±${((syn.vibmod ?? 0.5) * 100).toFixed(0)} cents`,
      });
    const held =
      (syn.penv ?? 0) *
      (syn.psustain ?? 1) *
      (1 - (syn.panchor ?? syn.psustain ?? 1));
    if (Math.abs(held - Math.round(held)) > centsOk / 100)
      tuning.push({
        track: track.id,
        cents: (held - Math.round(held)) * 100,
        detail: `pitch envelope holds ${(held * 100).toFixed(0)} cents off the note`,
      });
  }
  for (const track of json.tracks) {
    if (track.muted || track.sampler?.mode !== "oneshot") continue;
    for (const [name, ref] of Object.entries(track.sampler.voices)) {
      if (ref.accelerate || ref.squiz) continue;
      const c = 1200 * Math.log2(Math.abs(Number(ref.speed ?? 1)));
      const off = c - 100 * Math.round(c / 100);
      if (Math.abs(off) > centsOk)
        tuning.push({
          track: track.id,
          cents: off,
          detail: `voice ${name} speed ${ref.speed} is ${off.toFixed(0)} cents off the grid`,
        });
    }
  }
  return { notes, tuning };
}

const bookId = (src: string) =>
  src
    .split("/")
    .pop()!
    .replace(/\.(wav|flac|mp3|ogg)$/i, "");

/** The vocal books' sung notes, where each oneshot hit plays them. */
function placeBooks(json: ScoreJson, books: VocalBooks): SungLine[] {
  const tpb = json.ticksPerBeat;
  const tpBar = tpb * (json.beatsPerBar ?? 4);
  const out: SungLine[] = [];
  const byTrack = new Map(json.tracks.map((t) => [t.id, t]));
  const names = new Map<string, string[]>();
  for (const n of json.notes) {
    const track = byTrack.get(n.trackId);
    const sampler = track?.sampler;
    if (!track || track.muted || sampler?.mode !== "oneshot") continue;
    let sorted = names.get(track.id);
    if (!sorted) {
      sorted = Object.keys(sampler.voices).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      names.set(track.id, sorted);
    }
    const name = sorted[n.pitch - 36]; // SAMPLER_FIRST_SLOT
    const ref = name === undefined ? undefined : sampler.voices[name];
    if (!ref || ref.accelerate || ref.squiz) continue;
    const book = books[bookId(String(ref.src))];
    const part = book?.parts[name!];
    if (!book || !part) continue;
    const shift = Number(ref.shift ?? 0);
    const speed = Math.abs(Number(ref.speed ?? 1));
    const c = 1200 * Math.log2(speed);
    const whole = Math.round(c / 100);
    const lead = (book.lead ?? 0.25) * tpb;
    const line: SungLine = {
      id: `${track.id}:${name}@${Math.floor(n.startTick / tpBar)}`,
      track: track.id,
      part: name!,
      notes: [],
    };
    let k = 0;
    for (const [beat, midi, len, syl] of part.notes) {
      const isSyl = syl !== undefined && syl !== "~";
      const stress = isSyl ? part.stress?.[k] : undefined;
      if (isSyl) k++;
      const tick = n.startTick + lead + (beat * tpb) / speed;
      if (tick >= n.startTick + n.durationTicks) continue; // cut off
      const s: Sounding = {
        track: track.id,
        tick,
        ticks: Math.min(
          (len * tpb) / speed,
          n.startTick + n.durationTicks - tick,
        ),
        pitch: midi + shift + whole,
        cents: c - whole * 100,
        velocity: n.velocity ?? 0.8,
        sung: true,
        line: line.id,
      };
      if (syl !== undefined) s.syl = syl;
      if (stress) s.stress = stress;
      line.notes.push(s);
    }
    if (line.notes.length) out.push(line);
  }
  return out;
}

/** Lyric notes grouped into lines: a rest of a beat or more starts a new line. */
function lyricLines(notes: readonly Sounding[], tpb: number): SungLine[] {
  const byTrack = new Map<string, Sounding[]>();
  for (const n of notes)
    if (n.sung)
      (byTrack.get(n.track) ?? byTrack.set(n.track, []).get(n.track)!).push(n);
  const out: SungLine[] = [];
  for (const [track, list] of byTrack) {
    list.sort((a, b) => a.tick - b.tick || b.pitch - a.pitch);
    let cur: SungLine | undefined;
    let end = -Infinity;
    let k = 0;
    for (const n of list) {
      if (cur && n.tick === cur.notes[cur.notes.length - 1]!.tick) continue; // a chord: top note sings
      if (!cur || n.tick - end >= tpb) {
        cur = {
          id: `${track}:line${++k}@${n.tick}`,
          track,
          part: `line${k}`,
          notes: [],
        };
        out.push(cur);
      }
      n.line = cur.id;
      cur.notes.push(n);
      end = Math.max(end, n.tick + n.ticks);
    }
  }
  return out;
}

/**
 * The bar's chord from the bed when the song declares none: the lowest
 * note sounding on the downbeat is the bass, and the tones are the pitch
 * classes the sustained parts (median note ≥ 1 beat) hold for at least a
 * beat in the bar.
 */
function inferHarmony(
  notes: readonly Sounding[],
  bars: number,
  tpb: number,
  tpBar: number,
): (LintChord | undefined)[] {
  const byTrack = new Map<string, number[]>();
  for (const n of notes)
    if (!n.sung)
      (byTrack.get(n.track) ?? byTrack.set(n.track, []).get(n.track)!).push(
        n.ticks,
      );
  const bed = new Set<string>();
  for (const [track, lens] of byTrack) {
    const sorted = [...lens].sort((a, b) => a - b);
    if (sorted[Math.floor(sorted.length / 2)]! >= tpb) bed.add(track);
  }
  const out: (LintChord | undefined)[] = new Array(bars).fill(undefined);
  const weight = Array.from({ length: bars }, () => new Float64Array(12));
  const low: number[] = new Array(bars).fill(Infinity);
  for (const n of notes) {
    if (n.sung) continue;
    const first = Math.floor(n.tick / tpBar);
    const last = Math.min(bars - 1, Math.floor((n.tick + n.ticks - 1) / tpBar));
    for (let b = Math.max(0, first); b <= last; b++) {
      const from = Math.max(n.tick, b * tpBar);
      const to = Math.min(n.tick + n.ticks, (b + 1) * tpBar);
      if (from <= b * tpBar + tpb / 2 && n.pitch < 60)
        low[b] = Math.min(low[b]!, n.pitch);
      if (bed.has(n.track) && to - from >= tpb)
        weight[b]![mod12(n.pitch)]! += to - from;
    }
  }
  for (let b = 0; b < bars; b++) {
    const w = weight[b]!;
    const max = Math.max(...w);
    if (!(max > 0) || !Number.isFinite(low[b]!)) continue;
    const tones: number[] = [];
    for (let pc = 0; pc < 12; pc++) if (w[pc]! >= max * 0.25) tones.push(pc);
    out[b] = { bass: low[b]!, tones };
  }
  return out;
}

export type ModelOptions = Readonly<{
  id?: string;
  config?: LintConfig;
  books?: VocalBooks;
  detuneOk?: number;
  centsOk?: number;
}>;

/** Reads score JSON (`TrackScore.toJSON()` or a `.track.json`) into a lint model. */
export function songModel(
  score: unknown,
  options: ModelOptions = {},
): SongModel {
  const json = readScore(score);
  const config = options.config ?? {};
  const tpb = json.ticksPerBeat;
  const bpb = json.beatsPerBar ?? 4;
  const tpBar = tpb * bpb;
  const lastTick = json.notes.reduce(
    (m, n) => Math.max(m, n.startTick + n.durationTicks),
    0,
  );
  const bars = Math.max(json.bars ?? 0, Math.ceil(lastTick / tpBar));
  const unpitched = new Set(
    json.tracks.filter((t) => isUnpitched(t)).map((t) => t.id),
  );
  const { notes, tuning } = flatten(
    json,
    unpitched,
    options.detuneOk ?? 25,
    options.centsOk ?? 12,
  );
  const bookLines = placeBooks(json, options.books ?? {});
  const lines = [...bookLines, ...lyricLines(notes, tpb)].sort(
    (a, b) => a.notes[0]!.tick - b.notes[0]!.tick,
  );
  const sung = [
    ...bookLines.flatMap((l) => l.notes),
    ...notes.filter((n) => n.sung),
  ];
  // The lead: declared, else the track that sings the most syllables. A
  // track named vox/lead/vocal wins over a double that sings as much.
  const lead = new Set<string>();
  const trackIds = new Set(lines.map((l) => l.track));
  if (config.lead?.length) {
    for (const id of trackIds)
      if (config.lead.some((re) => new RegExp(`^(${re})$`).test(id)))
        lead.add(id);
  } else {
    const count = new Map<string, number>();
    for (const n of sung)
      if (n.syl !== "~") count.set(n.track, (count.get(n.track) ?? 0) + 1);
    const max = Math.max(0, ...count.values());
    const named = /^(vox|lead|vocals?|voice)$/;
    const top = [...count]
      .filter(([, c]) => c >= 0.75 * max)
      .sort(
        (a, b) =>
          Number(named.test(b[0])) - Number(named.test(a[0])) || b[1] - a[1],
      )[0];
    if (top) lead.add(top[0]);
  }
  const sections: BarSection[] = (json.sections ?? [])
    .map((s) => ({
      name: s.name,
      kind: sectionKind(s.name),
      start: s.startBar,
      bars: s.bars,
    }))
    .sort((a, b) => a.start - b.start);
  const sectionOf: (BarSection | undefined)[] = new Array(bars).fill(undefined);
  for (const s of sections)
    for (let b = s.start; b < Math.min(bars, s.start + s.bars); b++)
      sectionOf[b] = s;
  const declared = config.harmony?.map(chordOf);
  const chords = declared ?? inferHarmony(notes, bars, tpb, tpBar);
  const baseKey = json.key ?? "C";
  const keyChanges = [...(config.keys ?? [])].sort((a, b) => a.bar - b.bar);
  const keyAt = (bar: number) => {
    let key = baseKey;
    for (const k of keyChanges) if (k.bar <= bar) key = k.key;
    return key;
  };
  const scales = new Map<string, ReadonlySet<number>>();
  const scaleAt = (bar: number) => {
    const key = keyAt(bar);
    let s = scales.get(key);
    if (!s) scales.set(key, (s = new Set(keyScale(key))));
    return s;
  };
  return Object.freeze({
    id: options.id ?? "song",
    json,
    tpb,
    bpb,
    tpBar,
    bars,
    bpm: json.tempoBpm,
    spb: 60 / json.tempoBpm,
    key: baseKey,
    notes: notes.filter((n) => !n.sung),
    sung,
    lines,
    lead,
    sections,
    sectionAt: (bar: number) => sectionOf[bar],
    chordAt: (bar: number) => chords[bar] ?? undefined,
    declaredHarmony: declared !== undefined,
    keyAt,
    scaleAt,
    config,
    unpitched,
    tuning,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the parts of score JSON the lint reads (foreign input). */
export function readScore(value: unknown): ScoreJson {
  if (!isRecord(value)) throw new Error("lint: score must be an object");
  const { tempoBpm, ticksPerBeat, tracks, notes } = value;
  if (typeof tempoBpm !== "number" || !(tempoBpm > 0))
    throw new Error("lint: score tempoBpm must be a positive number");
  if (typeof ticksPerBeat !== "number" || !(ticksPerBeat > 0))
    throw new Error("lint: score ticksPerBeat must be a positive number");
  if (
    !Array.isArray(tracks) ||
    !tracks.every((t) => isRecord(t) && typeof t.id === "string")
  )
    throw new Error("lint: score tracks must be objects with ids");
  if (
    !Array.isArray(notes) ||
    !notes.every(
      (n) =>
        isRecord(n) &&
        typeof n.trackId === "string" &&
        typeof n.startTick === "number" &&
        typeof n.durationTicks === "number" &&
        typeof n.pitch === "number",
    )
  )
    throw new Error(
      "lint: score notes must have trackId, startTick, durationTicks and pitch",
    );
  return value as unknown as ScoreJson;
}

/**
 * A `VocalBookSpec`: `parts` as `[name, beats, notes, settings?]` with
 * `{ beat, midi, len, syl }` notes, as the shape the rules read.
 */
function fromSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const parts: Record<string, unknown> = {};
  for (const p of spec.parts as unknown[]) {
    if (!Array.isArray(p) || typeof p[0] !== "string" || !Array.isArray(p[2]))
      throw new Error("lint: book parts are [name, beats, notes, settings?]");
    const notes = (p[2] as unknown[]).flatMap((n) => {
      if (!isRecord(n) || typeof n.midi !== "number") return [];
      return [
        [n.beat, n.midi, n.len, ...(typeof n.syl === "string" ? [n.syl] : [])],
      ];
    });
    const opt = isRecord(p[3]) ? p[3] : {};
    parts[p[0]] = {
      notes,
      ...(typeof opt.pickup === "number" ? { pickup: opt.pickup } : {}),
    };
  }
  return { ...spec, parts };
}

/**
 * Reads vocal books: `dawn.book/v1` (`{ schema, books: { id: book } }`), a
 * bare `{ id: book }` map, with each book's parts in the lint's own shape
 * (`{ name: { notes: [[beat, midi, len, syl?]], pickup?, stress? } }`) or
 * a `VocalBookSpec` part list.
 */
export function readBooks(value: unknown): VocalBooks {
  if (!isRecord(value)) throw new Error("lint: a book file must be an object");
  const root = value.schema === "dawn.book/v1" ? value.books : value;
  if (!isRecord(root)) throw new Error("lint: dawn.book/v1 needs `books`");
  const out: Record<string, VocalBooks[string]> = {};
  for (const [id, raw] of Object.entries(root)) {
    const book =
      isRecord(raw) && Array.isArray(raw.parts) ? fromSpec(raw) : raw;
    if (!isRecord(book) || !isRecord(book.parts))
      throw new Error(`lint: book ${id.slice(0, 40)} needs parts`);
    const parts: Record<string, VocalBooks[string]["parts"][string]> = {};
    for (const [name, part] of Object.entries(book.parts)) {
      const raw = Array.isArray(part) ? { notes: part } : part;
      if (!isRecord(raw) || !Array.isArray(raw.notes))
        throw new Error(`lint: book part ${name.slice(0, 40)} needs notes`);
      for (const n of raw.notes)
        if (
          !Array.isArray(n) ||
          typeof n[0] !== "number" ||
          typeof n[1] !== "number" ||
          typeof n[2] !== "number" ||
          (n[3] !== undefined && typeof n[3] !== "string")
        )
          throw new Error(
            `lint: book part ${name.slice(0, 40)} notes are [beat, midi, len, syl?]`,
          );
      parts[name] = {
        notes: raw.notes as never,
        ...(typeof raw.pickup === "number" ? { pickup: raw.pickup } : {}),
        ...(Array.isArray(raw.stress) ? { stress: raw.stress as never } : {}),
      };
    }
    out[id] = {
      parts,
      ...(typeof book.lead === "number" ? { lead: book.lead } : {}),
      ...(typeof book.bpm === "number" ? { bpm: book.bpm } : {}),
    };
  }
  return out;
}
