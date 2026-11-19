// SPDX-License-Identifier: MIT
/**
 * The SDK's lint calibration: a wide baseline. DAWN judges its own songs by
 * numbers fitted to songs its listeners liked; those are DAWN's and are not
 * part of the SDK, so this edition of the module holds limits instead: what
 * a voice can sing, what a listener can make out, what the score format
 * holds. No song was tuned on them.
 *
 * Every archetype here is unfitted and all five share the same numbers, so
 * the rules that judge taste (register, silence, prosody, density, hook,
 * repetition, sameness) rarely fire and the vocal ones report warnings. The
 * rules that do not depend on taste find the same things either way: a note
 * outside the key, a clash held over the bass, a semitone on the beat. A
 * stressed syllable on a weak sixteenth is found too, as a warning.
 *
 * To fit the lint to the songs you like, pass your own `LintCalibration`
 * to `lintSong` or `lintStyle`, or override single numbers in a project's
 * `lint.json` under `style`.
 */
import type { LintCalibration } from "./style.ts";

const UNFITTED = Object.freeze({ calibrated: false, patch: {} });

export const CALIBRATION: LintCalibration = Object.freeze({
  base: {
    // In tune within 15 cents of the grid (a just major third is 14 off
    // equal temperament); a unison spread up to 30 cents is a sound.
    key: { centsOk: 15, detuneOk: 30, clashBeats: 1 },
    // Block chords that jump a fifth or more per change; inner leaps over
    // an octave. Parallel fifths are an idiom in most popular music.
    voiceLeading: { medianMotionMax: 7, innerLeapMax: 12, parallels: false },
    // C3 to G5: the notes most voices reach between them.
    register: {
      verseMidi: [48, 72],
      verseWindow: [43, 79],
      verseOutsideShare: 0.25,
      chorusMedianMidi: [48, 79],
      p90Max: 84,
    },
    // Anything from a wall of words to one line in ten bars.
    silence: { share: [0, 0.9] },
    // Fast speech is about 8 syllables a second; under 100 ms a syllable
    // is hard to make out.
    prosody: {
      maxSylPerSec: 8,
      max16thRun: 4,
      shortMs: 100,
      firstSyllableMs: 100,
      maxSylPerBeat: 4,
    },
    density: {
      chorusOnsetsPerSec: [0.5, 24],
      chorusVsVerse: 0.5,
      maxEmptyBars: 8,
    },
    hook: { presence: 0.5 },
    lyrics: {
      distinctLineRatio: 0.34,
      banned: [],
      bannedFix: {},
      spelling: {},
    },
    tricks: { featured: [0, 64] },
    // The score format's own limits (SCORE_LIMITS in core/score.ts).
    budgets: { maxNotes: 4096, maxLanePoints: 256 },
    sameness: {
      maxSharedClasses: 4,
      contourR: 0.97,
      melodicJaccard: 0.3,
      lyricOverlap: 0.15,
    },
  },
  archetypes: {
    banger: UNFITTED,
    ballad: UNFITTED,
    anthem: UNFITTED,
    lullaby: UNFITTED,
    interlude: UNFITTED,
  },
});
