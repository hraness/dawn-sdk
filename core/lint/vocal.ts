// SPDX-License-Identifier: MIT
/**
 * Lead-vocal rules: register per section, silence share, prosody (words
 * sung too fast, or not placed on the beats), hook presence, lyric
 * repetition and the lyric glossary.
 *
 * Prosody needs each syllable's stress and phoneme counts. A vocal book
 * may carry them (`stress`, dumped from misaki); without them single
 * syllables take the function-word rule (function words weak, content
 * words stressed) and a word of several syllables is not stress-checked.
 */
import type { Sounding, SongModel, SungLine } from "./model.ts";
import type { LintStyle } from "./style.ts";
import type { LintFinding, LintRuleId, Severity } from "./types.ts";

type Emit = (f: LintFinding) => void;

/** One-syllable words sung weak: every other one-syllable word is stressed. */
export const FUNCTION = new Set(
  `a an the and but or nor so if as of to in on at by for from with into
onto up out off than then that this these those there here is am are was were be been
being do does did has have had will would can could shall should may might must i i'm
i'll i've i'd you you're you'll you've me my mine your yours he him his she her hers it
it's its we us our they them their what when where who how not no just`.split(
    /\s+/,
  ),
);
const VOCABLES = new Set([
  "ah",
  "oh",
  "ooh",
  "mm",
  "hm",
  "la",
  "na",
  "oo",
  "uh",
]);

const quantile = (xs: readonly number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo]! + (s[Math.min(s.length - 1, lo + 1)]! - s[lo]!) * (i - lo);
};

const leadLines = (m: SongModel) => m.lines.filter((l) => m.lead.has(l.track));
const leadNotes = (m: SongModel) =>
  leadLines(m)
    .flatMap((l) => l.notes)
    .filter((n) => n.syl !== "~" || true);

const severityFor = (style: LintStyle, s: Severity): Severity =>
  !style.calibrated && s === "error" ? "warn" : s;

const partAllowed = (m: SongModel, rule: LintRuleId, line: SungLine) =>
  (m.config.allow ?? []).some((a) => {
    const scope = a.rule;
    if (
      scope === undefined ||
      !(rule === scope || rule.startsWith(`${scope}.`))
    )
      return false;
    if (a.part !== undefined && !new RegExp(`^(${a.part})$`).test(line.part))
      return false;
    if (a.track !== undefined && !new RegExp(`^(${a.track})$`).test(line.track))
      return false;
    return true;
  });

// ---------------------------------------------------------------------------
// register and silence

export function registerRules(m: SongModel, style: LintStyle, emit: Emit) {
  const notes = leadNotes(m);
  if (notes.length < 8) return;
  const kindOf = (n: Sounding) =>
    m.sectionAt(Math.floor(n.tick / m.tpBar))?.kind;
  const verse = notes.filter((n) => kindOf(n) === "verse").map((n) => n.pitch);
  const chorus = notes
    .filter((n) => kindOf(n) === "chorus")
    .map((n) => n.pitch);
  const r = style.register;
  const sev = severityFor(style, "error");
  const allowed = (rule: LintRuleId) =>
    (m.config.allow ?? []).some(
      (a) =>
        a.rule !== undefined &&
        (rule === a.rule || rule.startsWith(`${a.rule}.`)),
    );
  if (verse.length >= 8 && !allowed("register.verse")) {
    const med = quantile(verse, 0.5);
    const out =
      verse.filter((p) => p < r.verseWindow[0] || p > r.verseWindow[1]).length /
      verse.length;
    if (med < r.verseMidi[0] || med > r.verseMidi[1])
      emit({
        rule: "register.verse",
        severity: sev,
        where: {},
        message: `verse lead median ${med.toFixed(1)} is outside ${r.verseMidi[0]}–${r.verseMidi[1]}`,
        fix: `transpose the verse lines ${med > r.verseMidi[1] ? "down" : "up"} toward ${Math.round((r.verseMidi[0] + r.verseMidi[1]) / 2)} (verses sit low; the chorus lifts)`,
      });
    if (out > r.verseOutsideShare)
      emit({
        rule: "register.verse",
        severity: "warn",
        where: {},
        message: `${(out * 100).toFixed(0)}% of verse notes leave ${r.verseWindow[0]}–${r.verseWindow[1]}`,
        fix: "keep verse peaks for a key word; move the rest into the window",
      });
  }
  if (chorus.length >= 8 && !allowed("register.chorus")) {
    const med = quantile(chorus, 0.5);
    if (med < r.chorusMedianMidi[0] || med > r.chorusMedianMidi[1])
      emit({
        rule: "register.chorus",
        severity: sev,
        where: {},
        message: `chorus lead median ${med.toFixed(1)} is outside ${r.chorusMedianMidi[0]}–${r.chorusMedianMidi[1]}`,
        fix:
          med > r.chorusMedianMidi[1]
            ? "move the chorus down: above this range the vocal reads as too high"
            : "move the chorus up: below this range it does not lift over the verse",
      });
    if (verse.length >= 8 && med < quantile(verse, 0.5))
      emit({
        rule: "register.chorus",
        severity: "warn",
        where: {},
        message: `the chorus (median ${med.toFixed(1)}) sits below the verse (median ${quantile(verse, 0.5).toFixed(1)})`,
        fix: "lift the chorus a third or more over the verse",
      });
  }
  const all = notes.map((n) => n.pitch);
  const p90 = quantile(all, 0.9);
  if (p90 > r.p90Max && !allowed("register.p90"))
    emit({
      rule: "register.p90",
      severity: sev,
      where: {},
      message: `lead p90 ${p90.toFixed(1)} is over ${r.p90Max}`,
      fix: "bring the top tenth of the line down; keep one peak per chorus",
    });
}

/**
 * The lead's silent share of the sections it sings in (16th grid):
 * instrumental sections (intro, drop, outro) do not count, so the share
 * measures the rests between lines.
 */
export function silentShare(
  m: SongModel,
  notes: readonly Sounding[] = leadNotes(m),
): number {
  const step = m.tpb / 4;
  const slots = Math.ceil((m.bars * m.tpBar) / step);
  const on = new Uint8Array(slots);
  for (const n of notes)
    for (
      let s = Math.floor(n.tick / step);
      s < Math.min(slots, Math.ceil((n.tick + n.ticks) / step));
      s++
    )
      on[s] = 1;
  const perBar = m.tpBar / step;
  const spans = m.sections.length ? m.sections : [{ start: 0, bars: m.bars }];
  let total = 0;
  let sung = 0;
  for (const sec of spans) {
    let c = 0;
    for (
      let s = sec.start * perBar;
      s < Math.min(slots, (sec.start + sec.bars) * perBar);
      s++
    )
      c += on[s]!;
    if (c === 0) continue;
    total += sec.bars * perBar;
    sung += c;
  }
  return total ? 1 - sung / total : 1;
}

export function silenceRules(m: SongModel, style: LintStyle, emit: Emit) {
  const notes = leadNotes(m);
  if (notes.length < 8) return;
  const share = silentShare(m, notes);
  const [lo, hi] = style.silence.share;
  const allowed = (m.config.allow ?? []).some(
    (a) => a.rule === "vocal" || a.rule === "vocal.silence",
  );
  if ((share < lo || share > hi) && !allowed)
    emit({
      rule: "vocal.silence",
      severity: "warn",
      where: {},
      message: `the lead is silent ${(share * 100).toFixed(0)}% of the sections it sings in (${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}%)`,
      fix:
        share < lo
          ? "leave rests between lines and an instrumental peak"
          : "the song needs more singing, or a shorter intro/instrumental",
    });
}

// ---------------------------------------------------------------------------
// prosody

type Syl = {
  word: number;
  k: number;
  n: number;
  stress: number;
  onset: number;
  coda: number;
  long: boolean;
  func: boolean;
  /** Stress known (from the book) or a one-syllable word. */
  known: boolean;
  text: string;
};

const LONG_VOWEL =
  /ee|oo|ai|ay|oa|ou|ow|igh|ie|ea|ei|ey|oy|oi|ue|ui|[aeiou][^aeiouy]e$/;

function estimate(text: string) {
  const t = text.toLowerCase().replace(/[^a-z']/g, "");
  const onset = Math.min(3, /^[^aeiouy]*/.exec(t)![0].length);
  let coda = 0;
  while (
    coda < 3 &&
    coda < t.length &&
    !"aeiouy".includes(t[t.length - coda - 1]!)
  )
    coda++;
  return { onset: t.length ? onset : 1, coda, long: LONG_VOWEL.test(t) };
}

export function syllables(notes: readonly Sounding[]): Syl[] {
  const syls = notes.filter((n) => n.syl !== "~");
  const words: Sounding[][] = [];
  let cur: Sounding[] = [];
  for (const n of syls) {
    cur.push(n);
    if (!String(n.syl ?? "").endsWith("-")) {
      words.push(cur);
      cur = [];
    }
  }
  if (cur.length) words.push(cur);
  const out: Syl[] = [];
  words.forEach((w, wi) => {
    const text = w
      .map((x) => String(x.syl ?? "").replace(/-$/, ""))
      .join("")
      .toLowerCase();
    const bare = text.replace(/[^a-z']/g, "");
    const k = w.length;
    const func = k === 1 && FUNCTION.has(bare);
    w.forEach((n, j) => {
      const st = n.stress;
      const est = estimate(String(n.syl ?? ""));
      // A one-syllable word is stressed unless it is a function word
      // (contractions like "don't" are content words).
      let stress = st ? st[0] : 0;
      if (k === 1) stress = func ? 0 : 2;
      out.push({
        word: wi,
        k: j,
        n: k,
        stress,
        onset: st ? st[1] : est.onset,
        coda: st ? st[2] : est.coda,
        long: st ? st[3] === 1 : est.long,
        func,
        known: k === 1 || st !== undefined,
        text: String(n.syl ?? "").replace(/-$/, ""),
      });
    });
  });
  return out;
}

/** Metric strength of a position (beats from a downbeat) on the 16th grid. */
export function metric(beat: number, bpb = 4): number {
  const q = ((Math.round(beat * 4) % (bpb * 4)) + bpb * 4) % (bpb * 4);
  if (q === 0) return 4;
  if (bpb === 4 && q === 8) return 3;
  if (q % 4 === 0) return 2;
  if (q % 2 === 0) return 1;
  return 0;
}

/** A syllable held through a stronger position within half a beat is a push. */
export function effective(beat: number, end: number, bpb = 4): number {
  const m = metric(beat, bpb);
  let x = Math.floor(beat * 4 + 1e-6) / 4 + 0.25;
  while (x < Math.min(end, beat + 0.5) - 1e-6) {
    if (metric(x, bpb) > m) return Math.max(m, metric(x, bpb) - 1);
    x += 0.25;
  }
  return m;
}

const minMs = (s: Syl) =>
  45 * s.onset +
  35 * s.coda +
  (s.stress === 2 ? 130 : s.stress === 1 ? 110 : 70) +
  (s.long ? 30 : 0);

export type ProsodyProblem = Readonly<{
  kind: "short" | "weak" | "stress" | "shape" | "rush" | "rate" | "anchor";
  index: number;
  message: string;
}>;

/** Problems with one sung line; `beats` are positions in beats from a downbeat. */
export function lintLine(
  notes: readonly Sounding[],
  m: Pick<SongModel, "tpb" | "spb" | "bpb">,
  style: LintStyle,
): ProsodyProblem[] {
  const spb = m.spb * 1000;
  const S = syllables(notes);
  const beat = (n: Sounding) => n.tick / m.tpb;
  const idx = notes
    .map((n, i) => (n.syl !== "~" ? i : -1))
    .filter((i) => i >= 0);
  const on = idx.map((i) => beat(notes[i]!));
  const last = notes[notes.length - 1]!;
  const lens = idx.map((i, j) =>
    j + 1 < idx.length
      ? beat(notes[idx[j + 1]!]!) - beat(notes[i]!)
      : beat(last) + last.ticks / m.tpb - beat(notes[i]!),
  );
  const eff = on.map((b, i) => effective(b, b + lens[i]!, m.bpb));
  const probs: ProsodyProblem[] = [];
  const p = style.prosody;
  S.forEach((s, i) => {
    const ms = lens[i]! * spb;
    if (i === 0 && s.n === 1 && ms < p.firstSyllableMs)
      probs.push({
        kind: "short",
        index: i,
        message: `line-opening '${s.text}' ${ms.toFixed(0)} ms < ${p.firstSyllableMs} ms (heard as part of the next word)`,
      });
    else if (ms < 0.85 * minMs(s))
      probs.push({
        kind: "short",
        index: i,
        message: `'${s.text}' ${ms.toFixed(0)} ms < ${minMs(s)} ms to say`,
      });
    if (s.known && s.stress === 2 && !s.func && eff[i] === 0 && s.n > 1)
      probs.push({
        kind: "weak",
        index: i,
        message: `stressed '${s.text}' on a 16th`,
      });
  });
  for (let i = 0; i < S.length - 1; i++) {
    const a = S[i]!;
    const b = S[i + 1]!;
    if (a.word !== b.word || !a.known) continue;
    if (a.stress > b.stress && eff[i]! < metric(on[i + 1]!, m.bpb))
      probs.push({
        kind: "stress",
        index: i,
        message: `'${a.text}-${b.text}': stressed '${a.text}' weaker than '${b.text}'`,
      });
    if (b.stress > a.stress && eff[i + 1]! < eff[i]!)
      probs.push({
        kind: "stress",
        index: i + 1,
        message: `'${a.text}-${b.text}': stressed '${b.text}' weaker than '${a.text}'`,
      });
    if (
      a.stress > b.stress &&
      i + 1 < S.length - 1 &&
      lens[i]! * 1.2 < lens[i + 1]! &&
      lens[i]! * spb < 200
    )
      probs.push({
        kind: "shape",
        index: i,
        message: `'${a.text}-${b.text}' short-long against its stress`,
      });
  }
  let run = 0;
  for (let i = 0; i < lens.length - 1; i++) {
    run = lens[i]! * spb < p.shortMs ? run + 1 : 0;
    if (run === p.max16thRun + 1)
      probs.push({
        kind: "rush",
        index: i,
        message: `${run} syllables under ${p.shortMs} ms in a row ending '${S[i]!.text}'`,
      });
  }
  if (on.length > 3) {
    const span = ((on[on.length - 1]! - on[0]!) * spb) / 1000;
    const rate = span > 0 ? (on.length - 1) / span : 99;
    if (rate > p.maxSylPerSec)
      probs.push({
        kind: "rate",
        index: 0,
        message: `${rate.toFixed(1)} syllables/s`,
      });
  }
  const first = S.findIndex((s) => s.stress === 2 && !s.func && s.known);
  if (first >= 0 && eff[first]! < 2)
    probs.push({
      kind: "anchor",
      index: first,
      message: `first stress '${S[first]!.text}' is off the beat`,
    });
  return probs;
}

const PROSODY_RULE: Readonly<Record<ProsodyProblem["kind"], LintRuleId>> = {
  short: "prosody.short",
  weak: "prosody.stress",
  stress: "prosody.stress",
  shape: "prosody.stress",
  rush: "prosody.rush",
  rate: "prosody.rate",
  anchor: "prosody.anchor",
};

const singable = (l: SungLine) => {
  const words = l.notes.filter((n) => n.syl !== undefined && n.syl !== "~");
  if (words.length < 3) return false;
  return !words.every((n) =>
    VOCABLES.has(String(n.syl).replace(/-$/, "").toLowerCase()),
  );
};

export function prosodyRules(m: SongModel, style: LintStyle, emit: Emit) {
  const seen = new Set<string>();
  const runs = m.config.runs ? new RegExp(`^(${m.config.runs})$`) : undefined;
  // Each book part once: doubles sing the same part, so lint the lead's
  // copy first and skip the rest.
  const ordered = [...m.lines].sort(
    (a, b) => Number(m.lead.has(b.track)) - Number(m.lead.has(a.track)),
  );
  for (const l of ordered) {
    if (!singable(l)) continue;
    const key = l.part.startsWith("line") ? `${l.track}:${l.id}` : l.part;
    if (seen.has(key)) continue;
    seen.add(key);
    const bar = Math.floor(l.notes[0]!.tick / m.tpBar);
    for (const p of lintLine(l.notes, m, style)) {
      const rule = PROSODY_RULE[p.kind];
      // A declared run is a deliberate fast lick: its findings are notes.
      const isRun = runs?.test(l.part) ?? false;
      if (partAllowed(m, rule, l)) continue;
      const severity: Severity = isRun
        ? "info"
        : p.kind === "anchor" || p.kind === "shape"
          ? "warn"
          : severityFor(style, "error");
      const n = l.notes.filter((x) => x.syl !== "~")[p.index] ?? l.notes[0]!;
      const nb = Math.floor(n.tick / m.tpBar);
      emit({
        rule,
        severity,
        where: {
          bar: nb,
          beat: Math.round(((n.tick - nb * m.tpBar) / m.tpb) * 100) / 100,
          track: l.track,
          part: l.part,
          ...(m.sectionAt(bar) ? { section: m.sectionAt(bar)!.name } : {}),
        },
        message: `${l.part}: ${p.message}${isRun ? " (declared run)" : ""}`,
        fix:
          p.kind === "short" || p.kind === "rush" || p.kind === "rate"
            ? "give the syllables time to be said: fewer syllables, or spread them over the line's span (prosody set/rechart)"
            : p.kind === "anchor"
              ? "start the line so its first stressed word lands on a beat"
              : "put the stressed syllable on the stronger position (or push into it)",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// hook, lyric repetition, glossary

/** Interval + rhythm shape of a line's first notes (transposition-free). */
export function contour(
  notes: readonly Sounding[],
  tpb: number,
  count = 8,
): string {
  const ns = notes.filter((n) => n.syl !== "~").slice(0, count);
  const out: string[] = [];
  for (let i = 1; i < ns.length; i++)
    out.push(
      `${ns[i]!.pitch - ns[i - 1]!.pitch}/${Math.round(((ns[i]!.tick - ns[i - 1]!.tick) * 4) / tpb)}`,
    );
  return out.join(" ");
}

export function lineText(notes: readonly Sounding[]): string {
  let text = "";
  for (const n of notes) {
    if (n.syl === undefined || n.syl === "~") continue;
    const s = n.syl.toLowerCase();
    text += s.endsWith("-") ? s.slice(0, -1) : `${s} `;
  }
  return text
    .replace(/[^a-z' ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The hook: the lyric line (or, failing that, the pitch-and-rhythm shape of
 * a line's first five notes) that recurs in the most choruses. Every chorus
 * the lead sings in should carry it; a chorus with no lead line (a chop
 * drop) is not counted.
 */
export function hookRules(m: SongModel, style: LintStyle, emit: Emit) {
  const choruses = m.sections.filter((s) => s.kind === "chorus");
  if (choruses.length < 2) return;
  // Two syllables make a hook ("hel-lo"); a one-syllable call does not.
  const lines = leadLines(m).filter(
    (l) => l.notes.filter((n) => n.syl !== "~").length >= 2,
  );
  const keys = choruses.map((c) => {
    const set = new Set<string>();
    for (const l of lines) {
      const bar = Math.floor(l.notes[0]!.tick / m.tpBar);
      if (bar < c.start || bar >= c.start + c.bars) continue;
      const text = lineText(l.notes);
      set.add(`"${text}"`);
      if (l.notes.filter((n) => n.syl !== "~").length >= 4)
        set.add(`shape ${contour(l.notes, m.tpb, 5)}`);
    }
    return set;
  });
  const sungIn = choruses.filter((_, i) => keys[i]!.size > 0);
  if (sungIn.length < 2) return;
  const count = new Map<string, number>();
  for (const s of keys)
    for (const k of s) count.set(k, (count.get(k) ?? 0) + 1);
  // Prefer a lyric hook on ties: the words are what a listener keeps.
  const best = [...count].sort(
    (x, y) =>
      y[1] - x[1] ||
      Number(y[0].startsWith('"')) - Number(x[0].startsWith('"')),
  )[0]!;
  // A chorus that turns the hook's words ("I kept all of your notes" → "I
  // lost one of your notes") still carries it: half the words shared.
  const words = (k: string) => new Set(k.slice(1, -1).split(" "));
  const hookWords = best[0].startsWith('"') ? words(best[0]) : undefined;
  const carries = (set: ReadonlySet<string>) =>
    set.has(best[0]) ||
    (hookWords !== undefined &&
      [...set].some((k) => {
        if (!k.startsWith('"')) return false;
        const w = words(k);
        let n = 0;
        for (const x of w) if (hookWords.has(x)) n++;
        return n / (w.size + hookWords.size - n) >= 0.5;
      }));
  const carried = keys.filter((k) => k.size > 0 && carries(k)).length;
  const presence = carried / sungIn.length;
  if (best[1] < 2 || presence < style.hook.presence) {
    const missing = choruses
      .filter((_, i) => keys[i]!.size > 0 && !carries(keys[i]!))
      .map((c) => c.name);
    emit({
      rule: "hook.presence",
      severity: "warn",
      where: { section: missing[0] ?? choruses[0]!.name },
      message:
        best[1] < 2
          ? `no line recurs across the ${sungIn.length} sung choruses`
          : `the hook (${best[0]}) is in ${carried} of ${sungIn.length} sung choruses (missing: ${missing.join(", ")})`,
      fix: "sing the hook line, its words or its shape, in every chorus (a key lift keeps its intervals)",
    });
  }
}

export function lyricRules(m: SongModel, style: LintStyle, emit: Emit) {
  const lines = leadLines(m)
    .map((l) => ({ l, text: lineText(l.notes) }))
    .filter((x) => x.text.split(" ").length >= 2);
  // Repetition outside the choruses (the hook repeats by design).
  const verse = lines.filter(({ l }) => {
    const kind = m.sectionAt(Math.floor(l.notes[0]!.tick / m.tpBar))?.kind;
    return kind !== "chorus" && kind !== "post" && kind !== "outro";
  });
  const allowedRep = (m.config.allow ?? []).some(
    (a) => a.rule === "lyrics" || a.rule === "lyrics.repetition",
  );
  if (verse.length >= 6 && !allowedRep) {
    const ratio = new Set(verse.map((x) => x.text)).size / verse.length;
    if (ratio < style.lyrics.distinctLineRatio)
      emit({
        rule: "lyrics.repetition",
        severity: "warn",
        where: {},
        message: `only ${(ratio * 100).toFixed(0)}% of lines outside the chorus are distinct`,
        fix: "write new verse lines: repetition belongs to the hook",
      });
  }
  glossaryRules(
    m,
    lines.map((x) => ({ text: x.text, line: x.l })),
    style,
    emit,
  );
}

export function glossaryRules(
  m: SongModel,
  lines: readonly { text: string; line: SungLine }[],
  style: LintStyle,
  emit: Emit,
) {
  const seen = new Set<string>();
  for (const { text, line } of lines) {
    const words = text.split(" ");
    const bar = Math.floor(line.notes[0]!.tick / m.tpBar);
    const at = { bar, track: line.track, part: line.part };
    for (const w of words) {
      const us = Object.hasOwn(style.lyrics.spelling, w)
        ? style.lyrics.spelling[w]
        : undefined;
      if (!us || seen.has(`s:${w}`)) continue;
      seen.add(`s:${w}`);
      if (!partAllowed(m, "glossary.spelling", line))
        emit({
          rule: "glossary.spelling",
          severity: "warn",
          where: at,
          message: `"${w}" is not the glossary's spelling`,
          fix: `write "${us}"`,
        });
    }
    const padded = ` ${text} `;
    for (const phrase of style.lyrics.banned) {
      if (
        !padded.includes(` ${phrase} `) ||
        seen.has(`b:${phrase}:${line.part}`)
      )
        continue;
      seen.add(`b:${phrase}:${line.part}`);
      if (!partAllowed(m, "glossary.banned", line))
        emit({
          rule: "glossary.banned",
          severity: "error",
          where: at,
          message: `"${phrase}" is not in the glossary ("${text}")`,
          fix:
            (Object.hasOwn(style.lyrics.bannedFix, phrase)
              ? style.lyrics.bannedFix[phrase]
              : undefined) ??
            'use other words, or declare it: allow { rule: "glossary.banned", reason }',
        });
    }
  }
}
