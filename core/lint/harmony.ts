// SPDX-License-Identifier: MIT
/**
 * Key, chord and voice-leading rules, for any score: every sounding pitch
 * against the key and the bar's chord, held clashes against the bass,
 * tuning, and simultaneous seconds on the strong beats between parts and
 * against the sung line.
 *
 * A note is in key when its pitch class is in the key's scale or in the
 * bar's declared chord (a borrowed chord carries its own tones). A note
 * that rings a beat or more a minor ninth, a tritone or a bare major
 * seventh over the bar's bass is a clash unless it is a chord tone. Songs
 * declare deliberate chromatic notes in `allow` with a reason.
 */
import {
  allowMatches,
  mod12,
  pcName,
  pcOf,
  type Sounding,
  type SongModel,
} from "./model.ts";
import type { LintStyle } from "./style.ts";
import type { LintFinding, LintRuleId, Severity } from "./types.ts";

const AGAINST_BASS: Readonly<Record<number, string>> = {
  1: "a minor ninth",
  6: "a tritone",
  11: "a bare major seventh",
};

type Emit = (f: LintFinding) => void;

/** True when the song declares this pitch class (or any, for a rule-scoped entry) deliberate. */
export function allowedPc(
  m: SongModel,
  rule: LintRuleId,
  track: string,
  bar: number,
  pc: number | undefined,
): boolean {
  return (m.config.allow ?? []).some((a) => {
    if (!allowMatches(a, rule, track, bar)) return false;
    if (a.pcs) return pc !== undefined && a.pcs.some((p) => pcOf(p) === pc);
    // An unscoped entry needs pcs; a rule-scoped one allows the rule.
    return a.rule !== undefined && a.cents === undefined;
  });
}

const where = (m: SongModel, n: Sounding, tick = n.tick) => {
  const bar = Math.floor(tick / m.tpBar);
  return {
    bar,
    beat: Math.round(((tick - bar * m.tpBar) / m.tpb) * 100) / 100,
    track: n.track,
    ...(m.sectionAt(bar) ? { section: m.sectionAt(bar)!.name } : {}),
    ...(n.line ? { part: n.line.split(":")[1]!.split("@")[0]! } : {}),
  };
};

const chordPcs = (m: SongModel, bar: number) => {
  const ch = m.chordAt(bar);
  return new Set(ch ? [ch.bass, ...ch.tones].map(mod12) : []);
};

export function keyRules(m: SongModel, style: LintStyle, emit: Emit): void {
  const centsOk = (track: string) =>
    Math.max(
      style.key.centsOk,
      ...(m.config.allow ?? [])
        .filter(
          (a) =>
            a.cents !== undefined &&
            a.track !== undefined &&
            new RegExp(`^(${a.track})$`).test(track),
        )
        .map((a) => a.cents!),
    );
  for (const t of m.tuning)
    if (Math.abs(t.cents) > centsOk(t.track))
      emit({
        rule: "key.tuning",
        severity: "error",
        where: { track: t.track },
        message: `${t.track}: ${t.detail}`,
        fix: `retune it onto the semitone grid, or declare it: allow { track: "${t.track}", cents: ${Math.ceil(Math.abs(t.cents))}, reason }`,
      });
  for (const n of [...m.notes, ...m.sung]) {
    const w = where(m, n);
    const { bar } = w;
    const pc = mod12(n.pitch);
    if (Math.abs(n.cents) > centsOk(n.track))
      emit({
        rule: "key.tuning",
        severity: "error",
        where: w,
        pitch: n.pitch,
        message: `${pcName(pc)} sounds ${n.cents.toFixed(0)} cents off`,
        fix: "use a whole-semitone shift or speed, or declare the detune with allow { cents }",
      });
    const scale = m.scaleAt(bar);
    const tones = m.declaredHarmony ? chordPcs(m, bar) : new Set<number>();
    if (!scale.has(pc) && !tones.has(pc)) {
      if (!allowedPc(m, "key.scale", n.track, bar, pc))
        emit({
          rule: "key.scale",
          severity: "error",
          where: w,
          pitch: n.pitch,
          message: `${pcName(pc)} is outside ${m.keyAt(bar)}${n.sung ? " (sung)" : ""}`,
          fix: `move it to a scale or chord tone, or declare it: allow { track: "${n.track}", pcs: ["${pcName(pc)}"], bars: [${bar}, ${bar + 1}], reason }`,
        });
      continue;
    }
    for (let b = bar; b * m.tpBar < n.tick + n.ticks; b++) {
      const from = Math.max(n.tick, b * m.tpBar);
      const to = Math.min(n.tick + n.ticks, (b + 1) * m.tpBar);
      if (to - from < style.key.clashBeats * m.tpb) continue;
      const ch = m.chordAt(b);
      if (!ch) continue;
      const pcs = new Set([ch.bass, ...ch.tones].map(mod12));
      if (pcs.has(pc) || allowedPc(m, "key.clash", n.track, b, pc)) continue;
      const under = mod12(ch.bass);
      const over = mod12(pc - under);
      const name = AGAINST_BASS[over];
      if (!name) continue;
      // A sung major seventh over the bass is a line's colour, not a clash.
      if (n.sung && over === 11) continue;
      // An anticipation: the bar's last beat already on the next chord.
      const next = m.chordAt(b + 1);
      if (
        next &&
        from >= (b + 1) * m.tpBar - m.tpb &&
        [next.bass, ...next.tones].some((t) => mod12(t) === pc)
      )
        continue;
      emit({
        rule: "key.clash",
        // Inferred chords are a guess at the bed: report, do not fail.
        severity: m.declaredHarmony ? "error" : "warn",
        where: { ...w, bar: b, beat: b === bar ? w.beat : 0 },
        pitch: n.pitch,
        message: `${pcName(pc)} held ${((to - from) / m.tpb).toFixed(2)} beats, ${name} over the bass ${pcName(under)} (chord ${[...pcs].map(pcName).join(" ")})`,
        fix: "make it a chord tone, shorten it under a beat, or declare it in allow with a reason",
      });
    }
  }
}

/**
 * Simultaneous seconds on strong beats (beats 1 and 3): a note that starts
 * on the beat a semitone (or minor ninth) from another part's note still
 * sounding there, both at least half a beat long. A written part's note
 * that is a chord tone may rub a sung suspension; a sung note that starts
 * on the beat against a held part is reported too (no strong-beat semitone
 * against the vocal).
 */
export function rubRules(m: SongModel, _style: LintStyle, emit: Emit): void {
  const tpb = m.tpb;
  const long = [...m.notes, ...m.sung].filter(
    (n) => n.ticks >= tpb / 2 && n.pitch >= 48 && n.syl !== "~",
  );
  const byStart = [...long].sort((a, b) => a.tick - b.tick);
  const slop = tpb / 8;
  // Sounding notes indexed by beat for the overlap scan.
  const strongTicks = new Map<number, Sounding[]>();
  for (const o of long) {
    const first = Math.ceil((o.tick - slop) / (2 * tpb));
    const last = Math.floor((o.tick + o.ticks - slop - 1) / (2 * tpb));
    for (let k = first; k <= last; k++)
      (strongTicks.get(k) ?? strongTicks.set(k, []).get(k)!).push(o);
  }
  // One finding per beat and pitch-class pair; doubles and stacked pads
  // that play the same rub are folded into it.
  const found = new Map<string, { f: LintFinding; others: Set<string> }>();
  for (const n of byStart) {
    const rel = n.tick % (2 * tpb);
    if (rel > slop && rel < 2 * tpb - slop) continue; // not on beat 1 or 3
    const k = Math.round(n.tick / (2 * tpb));
    const beatTick = k * 2 * tpb;
    const bar = Math.floor(beatTick / m.tpBar);
    const pcs = chordPcs(m, bar);
    const pc = mod12(n.pitch);
    for (const o of strongTicks.get(k) ?? []) {
      if (o === n || o.track === n.track) continue;
      if (n.sung && o.sung) continue; // two sung lines: the backing's own business
      if (!(o.tick <= beatTick + slop && o.tick + o.ticks > beatTick + slop))
        continue;
      const d = mod12(n.pitch - o.pitch);
      if (d !== 1 && d !== 11) continue;
      const opc = mod12(o.pitch);
      // Both chord tones: the chord's own colour (a major seventh, an add9).
      if (pcs.has(pc) && pcs.has(opc)) continue;
      // Two parts: the one off the chord is the culprit and is reported
      // from its own side.
      if (!n.sung && pcs.has(pc)) continue;
      const rule: LintRuleId =
        n.sung || o.sung ? "harmony.vocal-rub" : "harmony.part-rub";
      if (
        allowedPc(m, rule, n.track, bar, pc) ||
        allowedPc(m, rule, o.track, bar, opc)
      )
        continue;
      // A sung non-chord tone on the beat against a chord tone is an
      // appoggiatura or suspension: info when it is in the key (colour),
      // a warning when it is outside the key and held a beat or more. A
      // part note off the chord against the voice, or two parts that rub,
      // is an error with declared harmony and a warning with inferred
      // harmony.
      const singerLeans = n.sung && pcs.has(opc) && !pcs.has(pc);
      const severity: Severity = singerLeans
        ? n.ticks >= tpb && !m.scaleAt(bar).has(pc)
          ? "warn"
          : "info"
        : m.declaredHarmony
          ? "error"
          : "warn";
      const key = `${rule}|${beatTick}|${pc}|${opc}`;
      const hit = found.get(key);
      if (hit) {
        hit.others.add(o.track);
        continue;
      }
      const culprit = singerLeans ? n.track : n.sung ? o.track : n.track;
      found.set(key, {
        others: new Set([o.track]),
        f: {
          rule,
          severity,
          where: where(m, n, beatTick),
          pitch: n.pitch,
          message: `${pcName(pc)}${n.sung ? " (sung)" : ""} against ${pcName(opc)}${o.sung ? " (sung)" : ""}, a semitone on the beat`,
          fix: singerLeans
            ? "a sung lean on the beat: resolve it sooner, or move the syllable off the beat"
            : `move ${culprit}'s ${pcName(n.sung ? opc : pc)} to a chord tone at that beat, start it off the beat, or declare it in allow { rule: "${rule}", track: "${culprit}", bars, reason }`,
        },
      });
    }
  }
  for (const { f, others } of found.values())
    emit({
      ...f,
      message: f.message.replace(
        " against ",
        ` against ${[...others].join("/")}'s `,
      ),
    });
}

/**
 * Voice leading of the bed (sustained, chordal parts): the summed semitone
 * motion per chord change, parallel fifths and octaves between the bass and
 * the top bed voice, and large leaps of inner voices.
 */
export function voiceLeadingRules(
  m: SongModel,
  style: LintStyle,
  emit: Emit,
): void {
  const byTrack = new Map<string, Sounding[]>();
  for (const n of m.notes)
    (byTrack.get(n.track) ?? byTrack.set(n.track, []).get(n.track)!).push(n);
  let bassLine: { tick: number; pitch: number }[] = [];
  let bassLow = Infinity;
  for (const [track, notes] of byTrack) {
    // A bed: chords of 3+ notes started together, most notes ≥ 1 beat.
    const groups = new Map<number, Sounding[]>();
    for (const n of notes)
      (groups.get(n.tick) ?? groups.set(n.tick, []).get(n.tick)!).push(n);
    const chords = [...groups]
      .filter(([, g]) => g.length >= 3 && g.every((n) => n.ticks >= m.tpb))
      .sort((a, b) => a[0] - b[0])
      .map(([tick, g]) => ({
        tick,
        pitches: g.map((n) => n.pitch).sort((a, b) => a - b),
      }));
    const avg = notes.reduce((s, n) => s + n.pitch, 0) / notes.length;
    if (chords.length < 0.5 * groups.size || chords.length < 4) {
      // Monophonic low part: a bass line candidate.
      if (
        avg < 52 &&
        avg < bassLow &&
        [...groups.values()].every((g) => g.length <= 2)
      ) {
        bassLow = avg;
        bassLine = [...groups]
          .sort((a, b) => a[0] - b[0])
          .map(([tick, g]) => ({
            tick,
            pitch: Math.min(...g.map((n) => n.pitch)),
          }));
      }
      continue;
    }
    const motions: number[] = [];
    let leaps = 0;
    let firstLeap: { tick: number; d: number } | undefined;
    for (let i = 1; i < chords.length; i++) {
      const a = chords[i - 1]!.pitches;
      const b = chords[i]!.pitches;
      if (a.join() === b.join()) continue;
      if (a.length !== b.length) {
        motions.push(
          Math.abs(b[0]! - a[0]!) +
            Math.abs(b[b.length - 1]! - a[a.length - 1]!),
        );
        continue;
      }
      let sum = 0;
      for (let v = 0; v < a.length; v++) {
        const d = Math.abs(b[v]! - a[v]!);
        sum += d;
        const inner = v > 0 && v < a.length - 1;
        if (inner && d > style.voiceLeading.innerLeapMax) {
          leaps++;
          firstLeap ??= { tick: chords[i]!.tick, d };
        }
      }
      // A root-position block chord moved in parallel: per voice, not summed.
      motions.push(sum / Math.max(1, a.length / 3));
    }
    if (motions.length >= 4) {
      const sorted = [...motions].sort((x, y) => x - y);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      if (median > style.voiceLeading.medianMotionMax)
        emit({
          rule: "voice.motion",
          severity: "info",
          where: { track },
          message: `${track}: chord changes move a median ${median.toFixed(1)} semitones (block chords jump)`,
          fix: "voice each chord to the nearest inversion of the last (minimal motion), e.g. voiceChord(..., { lead: 'smooth' })",
        });
    }
    if (leaps)
      emit({
        rule: "voice.leap",
        severity: "info",
        where: { ...whereTick(m, firstLeap!.tick), track },
        message: `${track}: ${leaps} inner-voice leap${leaps === 1 ? "" : "s"} over ${style.voiceLeading.innerLeapMax} semitones (first ${firstLeap!.d})`,
        fix: "keep inner voices within a fourth or fifth per change",
      });
    if (style.voiceLeading.parallels && bassLine.length && track !== "bass")
      parallelsAgainst(m, track, chords, bassLine, emit);
  }
}

const whereTick = (m: SongModel, tick: number) => {
  const bar = Math.floor(tick / m.tpBar);
  return {
    bar,
    beat: Math.round(((tick - bar * m.tpBar) / m.tpb) * 100) / 100,
  };
};

function parallelsAgainst(
  m: SongModel,
  track: string,
  chords: readonly { tick: number; pitches: number[] }[],
  bass: readonly { tick: number; pitch: number }[],
  emit: Emit,
): void {
  const bassAt = (tick: number) => {
    let p: number | undefined;
    for (const b of bass) {
      if (b.tick > tick) break;
      p = b.pitch;
    }
    return p;
  };
  let count = 0;
  let first: number | undefined;
  for (let i = 1; i < chords.length; i++) {
    const a = chords[i - 1]!;
    const b = chords[i]!;
    const ba = bassAt(a.tick);
    const bb = bassAt(b.tick);
    if (ba === undefined || bb === undefined || ba === bb) continue;
    const ta = a.pitches[a.pitches.length - 1]!;
    const tb = b.pitches[b.pitches.length - 1]!;
    if (ta === tb) continue;
    const ia = mod12(ta - ba);
    const ib = mod12(tb - bb);
    if (
      ia === ib &&
      (ia === 7 || ia === 0) &&
      Math.sign(tb - ta) === Math.sign(bb - ba)
    ) {
      count++;
      first ??= b.tick;
    }
  }
  if (count)
    emit({
      rule: "voice.parallel",
      severity: "info",
      where: { ...whereTick(m, first!), track },
      message: `${track}: ${count} parallel fifth/octave${count === 1 ? "" : "s"} between the bass and the top voice`,
      fix: "move the top voice by step or in contrary motion to the bass (fine in a power-chord idiom)",
    });
}
