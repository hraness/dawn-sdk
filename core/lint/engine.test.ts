// SPDX-License-Identifier: MIT
/**
 * The lint engine on thresholds this file states itself. DAWN's repository
 * and the public SDK hold different editions of core/lint/calibration.ts
 * (DAWN's fitted numbers; a wide baseline), so nothing here depends on
 * which one is in place: the rules that do not read a threshold are tested
 * as they are, and the ones that do are given a calibration.
 */
import { describe, expect, test } from "bun:test";
import type { LintConfig } from "./types.ts";
import { CALIBRATION } from "./calibration.ts";
import {
  formatFindings,
  lintAlbum,
  lintSong,
  lintStyle,
  LINT_ARCHETYPES,
  LINT_RULES,
  RULE_GROUPS,
  type LintCalibration,
  type LintFinding,
} from "./index.ts";

const TPB = 480;
const BAR = TPB * 4;

type N = {
  trackId: string;
  startTick: number;
  durationTicks: number;
  pitch: number;
  lyric?: string;
};

const note = (
  trackId: string,
  bar: number,
  beat: number,
  beats: number,
  pitch: number,
  lyric?: string,
): N => ({
  trackId,
  startTick: bar * BAR + beat * TPB,
  durationTicks: beats * TPB,
  pitch,
  ...(lyric !== undefined ? { lyric } : {}),
});

/** A C major bed for `bars` bars: C3 in the bass, C4 E4 G4 in the pad. */
const bed = (bars: number): N[] =>
  Array.from({ length: bars }, (_, b) => [
    note("bass", b, 0, 4, 48),
    ...[60, 64, 67].map((p) => note("pad", b, 0, 4, p)),
  ]).flat();

/** A 4/4 score in C major at `bpm`. */
function score(
  notes: N[],
  options: {
    bpm?: number;
    bars?: number;
    sections?: { name: string; startBar: number; bars: number }[];
  } = {},
) {
  const ids = [...new Set(notes.map((n) => n.trackId))];
  return {
    tempoBpm: options.bpm ?? 120,
    beatsPerBar: 4,
    ticksPerBeat: TPB,
    bars: options.bars ?? 8,
    key: "C major",
    tracks: ids.map((id) => ({
      id,
      name: id,
      instrument: id === "vox" ? "vox" : "pad",
    })),
    notes: notes.map((n, i) => ({ id: `n${i}`, velocity: 0.8, ...n })),
    sections: options.sections ?? [],
  };
}

const C = (n: number) => Array.from({ length: n }, () => "C");
const of = (fs: readonly LintFinding[], prefix: string) =>
  fs.filter((f) => f.rule.startsWith(prefix));

/**
 * A calibration written for these tests: one set of numbers, a strict
 * archetype (`banger`, marked fitted) and a lenient one (`ballad`, not
 * fitted), a child of each, and a glossary of two entries.
 */
const TEST_CALIBRATION: LintCalibration = {
  base: {
    key: { centsOk: 10, detuneOk: 20, clashBeats: 1 },
    voiceLeading: { medianMotionMax: 5, innerLeapMax: 12, parallels: false },
    register: {
      verseMidi: [55, 64],
      verseWindow: [50, 70],
      verseOutsideShare: 0.2,
      chorusMedianMidi: [60, 72],
      p90Max: 76,
    },
    silence: { share: [0, 1] },
    prosody: {
      maxSylPerSec: 5,
      max16thRun: 2,
      shortMs: 150,
      firstSyllableMs: 150,
      maxSylPerBeat: 3,
    },
    density: {
      chorusOnsetsPerSec: [0, 100],
      chorusVsVerse: 0,
      maxEmptyBars: 64,
    },
    hook: { presence: 0.5 },
    lyrics: {
      distinctLineRatio: 0,
      banned: ["robot", "plug in"],
      bannedFix: { robot: 'say "machine"' },
      spelling: { tonite: "tonight" },
    },
    tricks: { featured: [0, 64] },
    budgets: { maxNotes: 40, maxLanePoints: 256 },
    sameness: {
      maxSharedClasses: 4,
      contourR: 0.95,
      melodicJaccard: 0.3,
      lyricOverlap: 0.2,
    },
  },
  archetypes: {
    banger: { calibrated: true, patch: { budgets: { maxNotes: 30 } } },
    ballad: { calibrated: false, patch: {} },
    anthem: {
      parent: "banger",
      calibrated: false,
      patch: { hook: { presence: 0.9 } },
    },
    lullaby: { parent: "ballad", calibrated: false, patch: {} },
    interlude: { parent: "ballad", calibrated: false, patch: {} },
  },
};

describe("bass voicings", () => {
  const rubs = (s: unknown, config: LintConfig = {}) =>
    lintSong(s, { config, rules: ["harmony"] }).findings.filter(
      (finding) => finding.rule === "harmony.low-second",
    );

  test("reports the actual off-grid overlap in the sounding register", () => {
    const s = score([
      note("bow", 0, 3.78, 3.32, 38),
      note("bass", 1, 0.03, 2.56, 36),
    ]);
    const findings = rubs(s, { harmony: ["Cadd9", "Cadd9"] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "warn",
      where: { bar: 1, beat: 0.03, track: "bow" },
      pitch: 38,
    });
    expect(findings[0]!.message).toContain(
      "bass (C2) and bow (D2) overlap for 2.56 beats",
    );
  });

  test("catches a chord on one track and counts overlap across a barline", () => {
    const s = score([
      note("keys", 0, 3.5, 1, 46),
      note("keys", 0, 3.75, 0.5, 48),
    ]);
    expect(rubs(s)[0]!.message).toContain("keys (Bb2) and keys (C3)");
    const minor = score([
      note("keys", 0, 0, 1, 47),
      note("bow", 0, 0.5, 1, 48),
    ]);
    expect(rubs(minor)[0]!.message).toContain("a semitone");
  });

  test("a lower-middle semitone needs a full beat even when both notes belong to the chord", () => {
    for (const [low, high, hold, count] of [
      [55, 56, 1.66, 1],
      [55, 56, 0.99, 0],
      [55, 57, 2, 0],
      [59, 60, 1, 1],
      [60, 61, 2, 0],
      [55, 68, 1.66, 0],
    ] as const) {
      const s = score([
        note("tenor", 0, 0.2, 3, low),
        note("keys", 0, 0.4, hold, high),
      ]);
      expect(rubs(s, { harmony: ["Abmaj7"] })).toHaveLength(count);
    }
  });

  test("lets short, octave-spaced and upper extensions pass", () => {
    for (const [lo, hi, at, len] of [
      [36, 38, 0.8, 2],
      [36, 38, 1, 1],
      [36, 50, 0, 1],
      [48, 50, 0, 1],
      [36, 36, 0, 1],
    ]) {
      expect(
        rubs(score([note("a", 0, 0, 1, lo!), note("b", 0, at!, len!, hi!)])),
      ).toEqual([]);
    }
  });

  test("honours either track's scoped allowance and reports an unexempt later bar", () => {
    const s = score([
      note("piano", 0, 3, 2, 37),
      note("bass", 0, 3.25, 1.75, 36),
    ]);
    const allow = {
      rule: "harmony.low-second",
      track: "bass",
      pcs: ["C"],
      reason: "deliberate cluster",
    };
    expect(rubs(s, { allow: [allow] })).toEqual([]);
    expect(
      rubs(s, { allow: [{ ...allow, bars: [0, 1] }] })[0]!.where,
    ).toMatchObject({ bar: 1, beat: 0 });
  });

  test("reads the real instruments on drum-named parts and ignores MIDI selectors", () => {
    const tracks = [
      { id: "kick", instrument: "sine" },
      { id: "tom-bell", instrument: "modal", modal: { preset: "bell" } },
      { id: "shore", instrument: "texture", texture: { type: "ocean" } },
      { id: "chip", instrument: "texture", texture: { type: "porcelain" } },
      { id: "hits", instrument: "drumkit" },
      { id: "air", instrument: "pink" },
      { id: "snare-legacy" },
    ];
    const fixture = score(tracks.map((t) => note(t.id, 0, 0, 1, 37)));
    const report = lintSong(
      {
        ...fixture,
        tracks,
        notes: fixture.notes.map((n) => ({ ...n, cents: 45 })),
      },
      { rules: ["key"] },
    );
    for (const rule of ["key.scale", "key.tuning"])
      expect(
        report.findings
          .filter((f) => f.rule === rule)
          .map((f) => f.where.track)
          .sort(),
      ).toEqual(["kick", "tom-bell"]);
  });
});

describe("rules that read no threshold", () => {
  test("a note outside the key is a key.scale error; an allow entry with a reason clears it", () => {
    const s = score([...bed(4), note("lead", 2, 0, 1, 61)]);
    const bad = lintSong(s, { config: { harmony: C(4) }, rules: ["key"] });
    const found = of(bad.findings, "key.scale");
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("error");
    expect(found[0]!.where).toMatchObject({ bar: 2, track: "lead" });
    expect(bad.ok).toBe(false);
    const ok = lintSong(s, {
      config: {
        harmony: C(4),
        allow: [
          {
            track: "lead",
            pcs: ["Db"],
            bars: [2, 3],
            reason: "a chromatic passing note",
          },
        ],
      },
      rules: ["key"],
    });
    expect(of(ok.findings, "key.")).toHaveLength(0);
    expect(ok.ok).toBe(true);
  });

  test("a song in its key and on its chords has no key findings", () => {
    const s = score([...bed(4), note("lead", 1, 0, 2, 64)]);
    const report = lintSong(s, { config: { harmony: C(4) }, rules: ["key"] });
    expect(report.findings).toHaveLength(0);
    expect(report.counts).toEqual({ error: 0, warn: 0, info: 0 });
  });

  test("a trick featured twice in the ledger is a repeat", () => {
    const report = lintSong(score(bed(2)), {
      config: {
        tricks: [
          { id: "tape-stop", bars: [1, 2] },
          { id: "tape-stop", bars: [5, 6] },
        ],
      },
      rules: ["tricks"],
    });
    expect(of(report.findings, "tricks.repeat")).toHaveLength(1);
  });

  test("a finding prints as one line that names the rule, the place and the fix", () => {
    const s = score([...bed(4), note("lead", 2, 0, 1, 61)]);
    const { findings } = lintSong(s, {
      config: { harmony: C(4) },
      rules: ["key"],
    });
    const lines = formatFindings(findings);
    expect(lines.join("\n")).toContain("key.scale");
    expect(lines.join("\n")).toContain("lead");
  });

  test("every rule id belongs to a rule group", () => {
    for (const id of LINT_RULES)
      expect(RULE_GROUPS as readonly string[]).toContain(id.split(".")[0]!);
  });
});

describe("a calibration decides the thresholds", () => {
  test("lintStyle layers the base, the parent's patch, the archetype's own and the caller's", () => {
    const banger = lintStyle("banger", undefined, TEST_CALIBRATION);
    expect(banger.archetype).toBe("banger");
    expect(banger.calibrated).toBe(true);
    expect(banger.budgets).toEqual({ maxNotes: 30, maxLanePoints: 256 });
    const anthem = lintStyle("anthem", undefined, TEST_CALIBRATION);
    expect(anthem.calibrated).toBe(false);
    expect(anthem.budgets.maxNotes).toBe(30);
    expect(anthem.hook.presence).toBe(0.9);
    const ballad = lintStyle(
      "ballad",
      { budgets: { maxNotes: 12 } },
      TEST_CALIBRATION,
    );
    expect(ballad.budgets).toEqual({ maxNotes: 12, maxLanePoints: 256 });
    expect(ballad.prosody).toEqual(TEST_CALIBRATION.base.prosody);
    // The table itself is never written to.
    expect(TEST_CALIBRATION.base.budgets.maxNotes).toBe(40);
  });

  test("the note budget is the calibration's, per archetype, and a project's own number wins", () => {
    // 8 bars of bed: 32 notes.
    const s = score(bed(8));
    const lint = (archetype: "banger" | "ballad", maxNotes?: number) =>
      of(
        lintSong(s, {
          config: {
            archetype,
            ...(maxNotes !== undefined
              ? { style: { budgets: { maxNotes } } }
              : {}),
          },
          rules: ["budget"],
          calibration: TEST_CALIBRATION,
        }).findings,
        "budget.notes",
      );
    expect(lint("banger")).toHaveLength(1);
    expect(lint("banger")[0]!.message).toContain("budget 30");
    expect(lint("ballad")).toHaveLength(0);
    expect(lint("ballad", 16)).toHaveLength(1);
    expect(lint("banger", 64)).toHaveLength(0);
  });

  test("the register limits are the calibration's; an unfitted archetype warns where a fitted one fails", () => {
    const sections = [
      { name: "Verse", startBar: 0, bars: 4 },
      { name: "Chorus", startBar: 4, bars: 4 },
    ];
    const line = (bar0: number, pitch: number) =>
      Array.from({ length: 4 }, (_, b) => [
        note("vox", bar0 + b, 0, 1, pitch, "la"),
        note("vox", bar0 + b, 1, 1, pitch, "la"),
      ]).flat();
    // A verse on A4, over the 55–64 the test calibration allows.
    const s = score([...bed(8), ...line(0, 69), ...line(4, 69)], { sections });
    const lint = (archetype: "banger" | "ballad") =>
      of(
        lintSong(s, {
          config: {
            archetype,
            harmony: C(8),
            style: { budgets: { maxNotes: 4096 } },
          },
          rules: ["register"],
          calibration: TEST_CALIBRATION,
        }).findings,
        "register.verse",
      ).filter((f) => f.message.includes("median"));
    expect(lint("banger").map((f) => f.severity)).toEqual(["error"]);
    expect(lint("ballad").map((f) => f.severity)).toEqual(["warn"]);
    // The same verse inside a calibration that allows it.
    const wide: LintCalibration = {
      ...TEST_CALIBRATION,
      base: {
        ...TEST_CALIBRATION.base,
        register: {
          ...TEST_CALIBRATION.base.register,
          verseMidi: [55, 72],
        },
      },
    };
    expect(
      of(
        lintSong(s, {
          config: { archetype: "banger", harmony: C(8) },
          rules: ["register"],
          calibration: wide,
        }).findings,
        "register.verse",
      ).filter((f) => f.message.includes("median")),
    ).toHaveLength(0);
  });

  test("the glossary is the calibration's word lists, with its fix or a general one", () => {
    const sing = (bar: number, words: string[]) =>
      words.map((w, i) => note("vox", bar, i, 1, 60 + (i % 3) * 2, w));
    const s = score([
      ...bed(3),
      ...sing(0, ["my", "ro-", "bot", "sings"]),
      ...sing(1, ["plug", "in", "to-", "nite"]),
      ...sing(2, ["my", "bot", "signs", "in"]),
    ]);
    const { findings } = lintSong(s, {
      rules: ["glossary"],
      calibration: TEST_CALIBRATION,
    });
    const banned = of(findings, "glossary.banned");
    expect(banned.map((f) => f.severity)).toEqual(["error", "error"]);
    const robot = banned.find((f) => f.message.includes('"robot"'))!;
    expect(robot.fix).toBe('say "machine"');
    const plug = banned.find((f) => f.message.includes('"plug in"'))!;
    expect(plug.fix).toContain("glossary.banned");
    const spelling = of(findings, "glossary.spelling");
    expect(spelling).toHaveLength(1);
    expect(spelling[0]!.message).toContain("tonite");
    expect(spelling[0]!.fix).toBe('write "tonight"');
    // A calibration with no word lists has no glossary findings.
    const none: LintCalibration = {
      ...TEST_CALIBRATION,
      base: {
        ...TEST_CALIBRATION.base,
        lyrics: {
          distinctLineRatio: 0,
          banned: [],
          bannedFix: {},
          spelling: {},
        },
      },
    };
    expect(
      lintSong(s, { rules: ["glossary"], calibration: none }).findings,
    ).toHaveLength(0);
    // A word that is also the name of an Object method is not a spelling.
    const odd = score([
      ...bed(1),
      ...sing(0, ["con-", "struc-", "tor", "now"]),
    ]);
    expect(
      lintSong(odd, { rules: ["glossary"], calibration: TEST_CALIBRATION })
        .findings,
    ).toHaveLength(0);
  });

  test("an album lints against a calibration too", () => {
    const sing = (bar: number, words: string[], pitches: number[]) =>
      words.map((w, i) => note("vox", bar, i, 1, pitches[i]!, w));
    const one = score([
      ...bed(4),
      ...sing(0, ["hold", "the", "light", "up"], [64, 62, 67, 64]),
      ...sing(1, ["walk", "on", "home", "now"], [60, 62, 60, 59]),
      ...sing(2, ["hold", "the", "light", "up"], [64, 62, 67, 64]),
      ...sing(3, ["all", "the", "way", "down"], [67, 65, 64, 62]),
    ]);
    const models = ["a", "b"].map(
      (id) =>
        lintSong(one, { id, rules: [], calibration: TEST_CALIBRATION }).model,
    );
    const strict = lintAlbum(models, { calibration: TEST_CALIBRATION });
    expect(strict.findings.map((f) => f.rule).sort()).toEqual([
      "album.lyrics",
      "album.melody",
    ]);
    expect(strict.pairs).toHaveLength(1);
    // Nothing two songs can share reaches these limits.
    const lax: LintCalibration = {
      ...TEST_CALIBRATION,
      base: {
        ...TEST_CALIBRATION.base,
        sameness: {
          maxSharedClasses: 99,
          contourR: 2,
          melodicJaccard: 2,
          lyricOverlap: 2,
        },
      },
    };
    expect(lintAlbum(models, { calibration: lax }).findings).toHaveLength(0);
  });
});

describe("the calibration in place", () => {
  test("is complete: every archetype resolves to a full set of thresholds", () => {
    const fields = Object.keys(TEST_CALIBRATION.base).sort();
    expect(Object.keys(CALIBRATION.base).sort()).toEqual(fields);
    expect(Object.keys(CALIBRATION.archetypes).sort()).toEqual(
      [...LINT_ARCHETYPES].sort(),
    );
    for (const archetype of LINT_ARCHETYPES) {
      const style = lintStyle(archetype);
      expect(style.archetype).toBe(archetype);
      expect(typeof style.calibrated).toBe("boolean");
      for (const field of fields)
        expect(
          Object.keys(style[field as keyof typeof style] as object).sort(),
        ).toEqual(
          Object.keys(
            TEST_CALIBRATION.base[
              field as keyof typeof TEST_CALIBRATION.base
            ] as object,
          ).sort(),
        );
      const parent = CALIBRATION.archetypes[archetype].parent;
      // One level of inheritance: a parent has no parent of its own.
      if (parent) expect(CALIBRATION.archetypes[parent].parent).toBeUndefined();
    }
  });

  test("its ranges are ordered and its word lists are lower-case", () => {
    for (const archetype of LINT_ARCHETYPES) {
      const style = lintStyle(archetype);
      for (const [lo, hi] of [
        style.register.verseMidi,
        style.register.verseWindow,
        style.register.chorusMedianMidi,
        style.silence.share,
        style.density.chorusOnsetsPerSec,
        style.tricks.featured,
      ])
        expect(lo).toBeLessThanOrEqual(hi);
      for (const phrase of style.lyrics.banned)
        expect(phrase).toBe(phrase.toLowerCase());
      for (const [word, spelling] of Object.entries(style.lyrics.spelling)) {
        expect(word).toBe(word.toLowerCase());
        expect(spelling.length).toBeGreaterThan(0);
      }
      for (const phrase of Object.keys(style.lyrics.bannedFix))
        expect(style.lyrics.banned).toContain(phrase);
    }
  });
});
