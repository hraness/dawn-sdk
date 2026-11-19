// SPDX-License-Identifier: MIT
/**
 * The thresholds the lint reads, per archetype. Every rule takes its numbers
 * and word lists from a `LintStyle`, never from a literal, so a song (the
 * `style` field of its `lint.json`), a style spec or a caller can override
 * any of them.
 *
 * Where the numbers come from is a calibration (./calibration.ts): a base
 * table and what each archetype changes. The edition of that module in the
 * public SDK is a wide baseline that no song was tuned on, so the rules
 * that judge taste rarely fire there, and the vocal ones report warnings.
 * DAWN's own edition is fitted to songs its listeners liked and is not part
 * of the SDK. Pass your own calibration to `lintStyle` or `lintSong` to fit
 * the lint to the songs you like.
 */
import { CALIBRATION } from "./calibration.ts";

export type LintRange = readonly [min: number, max: number];

export type LintArchetype =
  "banger" | "ballad" | "anthem" | "lullaby" | "interlude";

export const LINT_ARCHETYPES: readonly LintArchetype[] = Object.freeze([
  "banger",
  "ballad",
  "anthem",
  "lullaby",
  "interlude",
]);

export type LintStyle = Readonly<{
  archetype: LintArchetype;
  /** False until the archetype is calibrated on ≥3 liked own renders: its findings drop to warnings. */
  calibrated: boolean;
  key: Readonly<{
    /** A pitched source this far off the semitone grid (cents) is a tuning. */
    centsOk: number;
    /** A supersaw's unison spread up to ± this (cents) is its sound. */
    detuneOk: number;
    /** Notes at least this long (beats) are checked against the bar's chord. */
    clashBeats: number;
  }>;
  voiceLeading: Readonly<{
    /** Median summed semitone motion of a bed part per chord change. */
    medianMotionMax: number;
    /** An inner voice leap larger than this (semitones) is reported (info). */
    innerLeapMax: number;
    /** Report parallel fifths/octaves between the bass and the top bed voice (info). */
    parallels: boolean;
  }>;
  register: Readonly<{
    /** Verse lead median, MIDI. */
    verseMidi: LintRange;
    /** Verse notes outside this window are reported. */
    verseWindow: LintRange;
    /** Share of verse notes allowed outside `verseWindow`. */
    verseOutsideShare: number;
    /** Chorus lead median, MIDI. */
    chorusMedianMidi: LintRange;
    /** 90th percentile of the whole lead line, MIDI. */
    p90Max: number;
  }>;
  silence: Readonly<{
    /** Share of the song (bars) with no lead vocal sounding. */
    share: LintRange;
  }>;
  prosody: Readonly<{
    maxSylPerSec: number;
    /** Syllables under `shortMs` in a row before it is a rush. */
    max16thRun: number;
    shortMs: number;
    /** A one-syllable line opener needs this long to be heard. */
    firstSyllableMs: number;
    /** Lines sung over a song's own tempo: syllables per beat above this are a run. */
    maxSylPerBeat: number;
  }>;
  density: Readonly<{
    /** Score onsets per second in the chorus/drop (union of every part's 16th onsets, drums weighted). */
    chorusOnsetsPerSec: LintRange;
    /** The chorus must be at least this share of the verse's onset rate. */
    chorusVsVerse: number;
    /** Bars without any new onset before it is a hole (info). */
    maxEmptyBars: number;
  }>;
  hook: Readonly<{
    /** Share of choruses that must carry the hook (its words or shape). */
    presence: number;
  }>;
  lyrics: Readonly<{
    /** Distinct-line ratio outside the hook. */
    distinctLineRatio: number;
    /** Phrases the lyrics must not use (lower-case, whole words). */
    banned: readonly string[];
    /** What to write in place of a banned phrase, by phrase. */
    bannedFix: Readonly<Record<string, string>>;
    /** Spellings the lyrics replace: a word (lower-case) and the spelling to use. */
    spelling: Readonly<Record<string, string>>;
  }>;
  tricks: Readonly<{
    /** Featured tricks per song (soft). */
    featured: LintRange;
  }>;
  budgets: Readonly<{
    maxNotes: number;
    maxLanePoints: number;
  }>;
  sameness: Readonly<{
    /** Classes two songs may share (tempo band, key, drum family, palette, space, energy). */
    maxSharedClasses: number;
    /** Energy contour correlation above this counts as a shared class. */
    contourR: number;
    /** Melodic 4-gram (interval + rhythm) Jaccard between two songs' leads. */
    melodicJaccard: number;
    /** Lyric 3-gram overlap between two songs. */
    lyricOverlap: number;
  }>;
}>;

/**
 * A calibration: the thresholds every archetype starts from, and for each
 * archetype what it changes, the archetype it inherits from and whether its
 * numbers were fitted to songs (an archetype that was not reports its
 * vocal findings as warnings).
 */
export type LintCalibration = Readonly<{
  base: Omit<LintStyle, "archetype" | "calibrated">;
  archetypes: Readonly<
    Record<
      LintArchetype,
      Readonly<{ parent?: LintArchetype; calibrated: boolean; patch: Patch }>
    >
  >;
}>;

/** A partial `LintStyle`: every group may be partly overridden. */
export type Patch = Readonly<{
  [K in keyof Omit<LintStyle, "archetype" | "calibrated">]?: Partial<
    LintStyle[K]
  >;
}>;

function merge(base: LintStyle, patch: Patch | undefined): LintStyle {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [group, value] of Object.entries(patch)) {
    if (value === undefined || !(group in base)) continue;
    out[group] = Object.freeze({
      ...(base as unknown as Record<string, object>)[group],
      ...value,
    });
  }
  return out as LintStyle;
}

/**
 * The thresholds for an archetype (default `banger`), with `overrides`
 * applied last. An archetype inherits its parent's numbers. `calibration`
 * is the table they come from (default: this module's own).
 */
export function lintStyle(
  archetype: LintArchetype = "banger",
  overrides?: Patch,
  calibration: LintCalibration = CALIBRATION,
): LintStyle {
  const entry = calibration.archetypes[archetype];
  const parent = entry.parent
    ? calibration.archetypes[entry.parent].patch
    : undefined;
  const base = {
    ...calibration.base,
    archetype,
    calibrated: entry.calibrated,
  } as LintStyle;
  return Object.freeze(
    merge(merge(merge(base, parent), entry.patch), overrides),
  );
}

export function isLintArchetype(value: unknown): value is LintArchetype {
  return (
    typeof value === "string" &&
    (LINT_ARCHETYPES as readonly string[]).includes(value)
  );
}
