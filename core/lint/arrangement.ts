// SPDX-License-Identifier: MIT
/**
 * Arrangement rules from the score: onset density per section (the
 * render-based onset gate comes later; this is its score-side estimate),
 * note and automation budgets, and the featured-trick ledger with the
 * tricks the score itself shows.
 */
import type { SongModel } from "./model.ts";
import type { LintStyle } from "./style.ts";
import type { LintFinding, LintTrick } from "./types.ts";

type Emit = (f: LintFinding) => void;

/**
 * Onsets per second per section instance: distinct 16th slots where any
 * part (drums, pitched, sung) starts a note, over the section's seconds.
 */
export function sectionDensity(m: SongModel) {
  const step = m.tpb / 4;
  const slots = new Set<number>();
  for (const n of m.json.notes) {
    const t = m.json.tracks.find((x) => x.id === n.trackId);
    if (t?.muted) continue;
    slots.add(Math.round(n.startTick / step));
  }
  for (const n of m.sung)
    if (n.syl !== "~") slots.add(Math.round(n.tick / step));
  const perBar = new Float64Array(m.bars);
  for (const s of slots) {
    const bar = Math.floor((s * step) / m.tpBar);
    if (bar >= 0 && bar < m.bars) perBar[bar]! += 1;
  }
  const barSec = m.bpb * m.spb;
  return {
    perBar,
    sections: m.sections.map((s) => {
      let sum = 0;
      for (let b = s.start; b < Math.min(m.bars, s.start + s.bars); b++)
        sum += perBar[b]!;
      return { section: s, onsetsPerSec: sum / (s.bars * barSec) };
    }),
  };
}

export function densityRules(m: SongModel, style: LintStyle, emit: Emit) {
  const { perBar, sections } = sectionDensity(m);
  const d = style.density;
  const allowed = (rule: string) =>
    (m.config.allow ?? []).some(
      (a) =>
        a.rule !== undefined &&
        (rule === a.rule || rule.startsWith(`${a.rule}.`)),
    );
  const chorus = sections.filter((s) => s.section.kind === "chorus");
  const verse = sections.filter((s) => s.section.kind === "verse");
  if (!allowed("density.chorus"))
    for (const c of chorus) {
      const [lo, hi] = d.chorusOnsetsPerSec;
      if (c.onsetsPerSec < lo || c.onsetsPerSec > hi)
        emit({
          rule: "density.chorus",
          severity: "warn",
          where: { bar: c.section.start, section: c.section.name },
          message: `${c.section.name}: ${c.onsetsPerSec.toFixed(1)} score onsets/s (${lo}–${hi})`,
          fix:
            c.onsetsPerSec < lo
              ? "the chorus is sparse: add a moving part (hats, arp, chops)"
              : "the chorus is crowded: thin a layer",
        });
    }
  const mean = (xs: readonly { onsetsPerSec: number }[]) =>
    xs.reduce((s, x) => s + x.onsetsPerSec, 0) / xs.length;
  if (chorus.length && verse.length && !allowed("density.chorus-vs-verse")) {
    const c = mean(chorus);
    const v = mean(verse);
    if (c < v * d.chorusVsVerse)
      emit({
        rule: "density.chorus-vs-verse",
        severity: "warn",
        where: { section: chorus[0]!.section.name },
        message: `choruses average ${c.toFixed(1)} onsets/s against the verses' ${v.toFixed(1)}`,
        fix: "the chorus should be at least as busy as the verse: add a part or thin the verse",
      });
  }
  let run = 0;
  for (let b = 0; b < m.bars - 1; b++) {
    run = perBar[b] === 0 ? run + 1 : 0;
    if (run === d.maxEmptyBars + 1 && !allowed("density.hole"))
      emit({
        rule: "density.hole",
        severity: "info",
        where: { bar: b - d.maxEmptyBars },
        message: `${run} bars with no new onset from bar ${b - d.maxEmptyBars}`,
        fix: "a deliberate silence is fine; otherwise keep something moving",
      });
  }
}

const LANES = [
  "volumeAutomation",
  "panAutomation",
  "filterAutomation",
  "resonanceAutomation",
  "delayFeedbackAutomation",
  "delayMixAutomation",
  "wtAutomation",
] as const;

export function budgetRules(m: SongModel, style: LintStyle, emit: Emit) {
  const notes = m.json.notes.length;
  if (notes > style.budgets.maxNotes)
    emit({
      rule: "budget.notes",
      severity: "error",
      where: {},
      message: `${notes} notes (budget ${style.budgets.maxNotes})`,
      fix: "use loops, patterns or sampler phrases for repeats",
    });
  for (const t of m.json.tracks) {
    const lanes: [string, readonly unknown[]][] = [];
    for (const k of LANES) {
      const v = t[k];
      if (Array.isArray(v)) lanes.push([k, v]);
    }
    for (const [k, v] of Object.entries(t.fxAutomation ?? {}))
      if (Array.isArray(v)) lanes.push([k, v]);
    for (const [lane, pts] of lanes)
      if (pts.length > style.budgets.maxLanePoints)
        emit({
          rule: "budget.lane",
          severity: "error",
          where: { track: t.id },
          message: `${t.id} ${lane}: ${pts.length} points (budget ${style.budgets.maxLanePoints})`,
          fix: "thin the lane (ramps need two points) or use an LFO",
        });
  }
}

export type DetectedTrick = { id: string; bars: number[] };

/**
 * Tricks visible in the score itself: a tape stop or spin (a sampler voice
 * with `accelerate`), a reversed voice, a word-head stutter (one oneshot
 * voice hit 4+ times at a 16th or faster) and a chop roll (a keyed sampler
 * at 1/32 over 3+ pitches).
 */
export function detectTricks(m: SongModel): DetectedTrick[] {
  const found = new Map<string, Set<number>>();
  const add = (id: string, bar: number) =>
    (found.get(id) ?? found.set(id, new Set()).get(id)!).add(bar);
  const byTrack = new Map(m.json.tracks.map((t) => [t.id, t]));
  const hits = new Map<string, number[]>();
  const keyed = new Map<string, { tick: number; pitch: number }[]>();
  for (const n of m.json.notes) {
    const t = byTrack.get(n.trackId);
    const sampler = t?.sampler;
    if (!t || t.muted || !sampler) continue;
    const bar = Math.floor(n.startTick / m.tpBar);
    if (sampler.mode === "oneshot") {
      const names = Object.keys(sampler.voices).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const name = names[n.pitch - 36];
      const ref = name === undefined ? undefined : sampler.voices[name];
      if (!ref) continue;
      if (ref.accelerate)
        add(ref.accelerate < 0 ? "tape-stop" : "tape-spin", bar);
      if (Number(ref.speed ?? 1) < 0) add("reverse", bar);
      const k = `${t.id}|${name}`;
      (hits.get(k) ?? hits.set(k, []).get(k)!).push(n.startTick);
    } else {
      (keyed.get(t.id) ?? keyed.set(t.id, []).get(t.id)!).push({
        tick: n.startTick,
        pitch: n.pitch,
      });
    }
  }
  for (const ticks of hits.values()) {
    ticks.sort((a, b) => a - b);
    let run = 1;
    for (let i = 1; i < ticks.length; i++) {
      run = ticks[i]! - ticks[i - 1]! <= m.tpb / 4 ? run + 1 : 1;
      if (run === 4) add("stutter", Math.floor(ticks[i]! / m.tpBar));
    }
  }
  for (const notes of keyed.values()) {
    notes.sort((a, b) => a.tick - b.tick);
    for (let i = 0; i + 4 <= notes.length; i++) {
      const w = notes.slice(i, i + 4);
      const fast = w.every(
        (x, j) => j === 0 || x.tick - w[j - 1]!.tick <= m.tpb / 8,
      );
      if (fast && new Set(w.map((x) => x.pitch)).size >= 3)
        add("chop-roll", Math.floor(w[0]!.tick / m.tpBar));
    }
  }
  return [...found].map(([id, bars]) => ({
    id,
    bars: [...bars].sort((a, b) => a - b),
  }));
}

/** The song's featured tricks: its declared ledger. */
export const featuredTricks = (m: SongModel): LintTrick[] =>
  (m.config.tricks ?? []).filter((t) => t.featured !== false);

export function trickRules(m: SongModel, style: LintStyle, emit: Emit) {
  const ledger = featuredTricks(m);
  const ids = new Map<string, number>();
  for (const t of ledger) ids.set(t.id, (ids.get(t.id) ?? 0) + 1);
  for (const [id, n] of ids)
    if (n > 1)
      emit({
        rule: "tricks.repeat",
        severity: "error",
        where: {},
        message: `the ledger features ${id} ${n} times`,
        fix: "feature a trick once; a second use is a new trick or a foundation idiom (featured: false)",
      });
  if (ledger.length) {
    const [lo, hi] = style.tricks.featured;
    if (ledger.length < lo || ledger.length > hi)
      emit({
        rule: "tricks.count",
        severity: "info",
        where: {},
        message: `${ledger.length} featured tricks (${style.archetype} songs feature ${lo}–${hi})`,
        fix:
          ledger.length < lo
            ? "add a featured moment"
            : "drop a trick: too many reads as chaotic",
      });
  }
  // A detected trick that recurs outside the bars its ledger entry names.
  for (const d of detectTricks(m)) {
    const entries = ledger.filter(
      (t) => t.id === d.id || t.id.startsWith(`${d.id}-`),
    );
    const spans = entries
      .map((t) => t.bars)
      .filter((b): b is readonly [number, number] => b !== undefined);
    if (!entries.length || !spans.length) continue;
    const outside = d.bars.filter(
      (b) => !spans.some(([a, z]) => b >= a && b < z),
    );
    if (outside.length)
      emit({
        rule: "tricks.repeat",
        severity: "warn",
        where: { bar: outside[0]! },
        message: `${d.id} also plays at bar${outside.length === 1 ? "" : "s"} ${outside.slice(0, 6).join(", ")}, outside its ledger bars`,
        fix: "a featured trick plays where the ledger puts it; widen its bars or remove the repeat",
      });
  }
}
