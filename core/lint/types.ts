// SPDX-License-Identifier: MIT
/**
 * Shapes shared by the `dawn lint` rules: findings, the per-song lint
 * config (what a song declares about itself) and vocal books.
 */
import type { LintArchetype, Patch } from "./style.ts";

export type Severity = "error" | "warn" | "info";

/** Every rule id `dawn lint` can report. */
export const LINT_RULES = Object.freeze([
  "key.scale",
  "key.clash",
  "key.tuning",
  "harmony.part-rub",
  "harmony.vocal-rub",
  "voice.motion",
  "voice.parallel",
  "voice.leap",
  "register.verse",
  "register.chorus",
  "register.p90",
  "vocal.silence",
  "prosody.short",
  "prosody.stress",
  "prosody.rush",
  "prosody.rate",
  "prosody.anchor",
  "density.chorus",
  "density.chorus-vs-verse",
  "density.hole",
  "hook.presence",
  "lyrics.repetition",
  "glossary.spelling",
  "glossary.banned",
  "tricks.repeat",
  "tricks.count",
  "budget.notes",
  "budget.lane",
  "album.sameness",
  "album.contour",
  "album.melody",
  "album.lyrics",
  "album.trick",
] as const);
export type LintRuleId = (typeof LINT_RULES)[number];

/** Rule groups for `--rules` (the first segment of a rule id). */
export const RULE_GROUPS = Object.freeze([
  "key",
  "harmony",
  "voice",
  "register",
  "vocal",
  "prosody",
  "density",
  "hook",
  "lyrics",
  "glossary",
  "tricks",
  "budget",
  "album",
] as const);
export type RuleGroup = (typeof RULE_GROUPS)[number];

export type LintLocation = Readonly<{
  /** Project-relative source file, when the finding maps to one. */
  file?: string;
  line?: number;
  /** 0-based bar and beat in the bar. */
  bar?: number;
  beat?: number;
  track?: string;
  /** Vocal book part (line) name. */
  part?: string;
  /** Section name. */
  section?: string;
  /** Song id (album findings). */
  song?: string;
}>;

export type LintFinding = Readonly<{
  rule: LintRuleId;
  severity: Severity;
  where: LintLocation;
  message: string;
  /** How to fix it, or how to declare it deliberate. */
  fix: string;
  /** Pitch, when the finding is about one note. */
  pitch?: number;
}>;

/** A chord as the lint reads it: a bass and its tones (MIDI or pitch classes). */
export type LintChord = Readonly<{ bass: number; tones: readonly number[] }>;

/**
 * A deliberate exception, with its reason. `rule` scopes it (a rule id or
 * a group; absent: the key rules).
 */
export type LintAllow = Readonly<{
  rule?: string;
  /** Track id (or a book part name for prosody), a regex source. */
  track?: string;
  /** Book part names, a regex source (prosody, register). */
  part?: string;
  /** Pitch classes allowed (names, e.g. "E", "Gb"). */
  pcs?: readonly string[];
  /** Bars [from, to) the allowance holds; all bars when absent. */
  bars?: readonly [number, number];
  /** Off-grid cents allowed on this track (a detuned double). */
  cents?: number;
  /** Song ids (album rules). */
  songs?: readonly string[];
  reason: string;
}>;

/** A featured trick the song declares in its ledger. */
export type LintTrick = Readonly<{
  /** A neutral technique id (`tape-stop-word`, `pingpong-8th-space`). */
  id: string;
  /** Where it plays: bars [from, to). */
  bars?: readonly [number, number];
  /** False for a foundation idiom that does not count against the ledger. */
  featured?: boolean;
}>;

/**
 * What a song declares for the lint: `lint.json` in a project, the
 * `lint` field of `dawn.json`, or `<score>.lint.json` beside a score file.
 */
export type LintConfig = Readonly<{
  archetype?: LintArchetype;
  /** Threshold overrides on the archetype. */
  style?: Patch;
  /** Per-bar chords: chord symbols (`Fm`, `Db/F`), `{bass, tones}` or null. */
  harmony?: readonly (string | LintChord | null)[];
  /** Key changes: from `bar` on the song is in `key`. */
  keys?: readonly Readonly<{ bar: number; key: string }>[];
  allow?: readonly LintAllow[];
  /** Vocal book files (dawn.book/v1 or a bare map of books), project-relative. */
  books?: readonly string[];
  /** The lead vocal track ids (regex sources); default: the track that sings the most. */
  lead?: readonly string[];
  /** Book parts that are deliberate fast runs (regex source): prosody rate/rush/short pass. */
  runs?: string;
  /** The featured-trick ledger. */
  tricks?: readonly LintTrick[];
  /** Sameness classes the score cannot show (palette, space, chop, run...). */
  classes?: Readonly<Record<string, string>>;
}>;

/** One sung note of a vocal book part, in the part's slice time (beats). */
export type BookNote = readonly [
  beat: number,
  midi: number,
  len: number,
  syl?: string,
];
/** Per-syllable stress data: [stress 0..2, onset consonants, coda consonants, long vowel 0/1, function word 0/1]. */
export type BookStress = readonly [
  stress: number,
  onset: number,
  coda: number,
  long: number,
  func: number,
];
export type BookPart = Readonly<{
  /** Beats of slice before the part's bar-time 0 (book time → bar time). */
  pickup?: number;
  notes: readonly BookNote[];
  /** One entry per non-`~` syllable, when the book carries stress. */
  stress?: readonly BookStress[];
}>;
export type VocalBook = Readonly<{
  bpm?: number;
  /** Beats of consonant lead before slice beat 0 (default 0.25). */
  lead?: number;
  parts: Readonly<Record<string, BookPart>>;
}>;
/** Books keyed by sample id (the sampler voice file name without `.wav`). */
export type VocalBooks = Readonly<Record<string, VocalBook>>;
