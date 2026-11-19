// SPDX-License-Identifier: MIT
/**
 * Album rules: sameness between songs (shared classes, the energy
 * contour, melodic 4-grams and lyric 3-grams) and the featured-trick
 * ledger across the album. Every feature comes from the score, so the
 * album lints without a render; classes the score cannot show (palette,
 * vocal space, chop, run) come from each song's config.
 */
import { featuredTricks } from "./arrangement.ts";
import type { SongModel } from "./model.ts";
import type { LintStyle } from "./style.ts";
import type { LintFinding } from "./types.ts";
import { lineText } from "./vocal.ts";

/** Linear interpolation of `x` onto `points` evenly spaced positions. */
function resampleContour(x: readonly number[], points: number): Float64Array {
  const out = new Float64Array(points);
  const last = x.length - 1;
  for (let i = 0; i < points; i += 1) {
    const t = points === 1 ? 0 : (i * last) / (points - 1);
    const lo = Math.floor(t);
    const hi = Math.min(last, lo + 1);
    out[i] = x[lo]! + (x[hi]! - x[lo]!) * (t - lo);
  }
  return out;
}

/** Pearson correlation (NaN when either side is constant). */
function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

export type SongFeatures = Readonly<{
  id: string;
  classes: Readonly<Record<string, string>>;
  /** Per-bar layer energy: sounding tracks weighted by velocity. */
  contour: readonly number[];
  melody: ReadonlySet<string>;
  lyrics: ReadonlySet<string>;
  tricks: readonly string[];
}>;

/** Tempo band of the felt tempo. */
export function tempoBand(bpm: number): string {
  if (bpm < 125) return "slow";
  if (bpm < 138) return "mid";
  if (bpm < 150) return "fast";
  return "vfast";
}

/** 4x4, broken, halftime or none, from the kick and snare grid. */
export function drumFamily(m: SongModel): string {
  const byTrack = new Map(m.json.tracks.map((t) => [t.id, t]));
  const kick: number[] = [];
  const snare: number[] = [];
  for (const n of m.json.notes) {
    const t = byTrack.get(n.trackId);
    if (!t || t.muted) continue;
    const drum =
      t.kit !== undefined || /^(kit|drums?)$/.test(String(t.instrument));
    const isKick =
      /kick|bd/.test(t.id) || (drum && (n.pitch === 35 || n.pitch === 36));
    const isSnare =
      /snare|clap|sd/.test(t.id) ||
      (drum && (n.pitch === 38 || n.pitch === 39 || n.pitch === 40));
    if (isKick) kick.push(n.startTick);
    else if (isSnare) snare.push(n.startTick);
  }
  const tpb = m.tpb;
  const pos = (ticks: number[]) => {
    const bars = new Map<number, Set<number>>();
    for (const t of ticks) {
      const bar = Math.floor(t / m.tpBar);
      (bars.get(bar) ?? bars.set(bar, new Set()).get(bar)!).add(
        Math.round(((t % m.tpBar) * 4) / tpb),
      );
    }
    return [...bars.values()];
  };
  // Kicks of every kick track together, per bar.
  const kb = pos(kick);
  // No kick through most of the song: a drumless song (a heartbeat kick
  // in one chorus does not make it a groove).
  if (kb.length < 0.25 * m.bars) return "none";
  // Four on the floor: all four quarters, at most one syncopated kick.
  const fourFloor = kb.filter(
    (s) =>
      [0, 4, 8, 12].every((q) => s.has(q)) &&
      [...s].filter((x) => x % 4 !== 0).length <= 1,
  ).length;
  if (fourFloor / kb.length >= 0.6) return "4x4";
  const sb = pos(snare);
  const half = sb.filter((s) => s.has(8) && !s.has(4) && !s.has(12)).length;
  if (sb.length && half / sb.length >= 0.6) return "halftime";
  return "broken";
}

function contourOf(m: SongModel): number[] {
  const layers = Array.from(
    { length: m.bars },
    () => new Map<string, number>(),
  );
  for (const n of [...m.json.notes]) {
    const bar = Math.floor(n.startTick / m.tpBar);
    if (bar < 0 || bar >= m.bars) continue;
    const l = layers[bar]!;
    l.set(n.trackId, Math.max(l.get(n.trackId) ?? 0, n.velocity ?? 0.8));
  }
  return layers.map((l) => [...l.values()].reduce((a, b) => a + b, 0));
}

function melodyGrams(m: SongModel): Set<string> {
  const out = new Set<string>();
  for (const l of m.lines) {
    if (!m.lead.has(l.track)) continue;
    const ns = l.notes.filter((n) => n.syl !== "~");
    const tok: string[] = [];
    for (let i = 1; i < ns.length; i++)
      tok.push(
        `${ns[i]!.pitch - ns[i - 1]!.pitch}/${Math.round(((ns[i]!.tick - ns[i - 1]!.tick) * 4) / m.tpb)}`,
      );
    for (let i = 0; i + 4 <= tok.length; i++)
      out.add(tok.slice(i, i + 4).join(" "));
  }
  return out;
}

function lyricGrams(m: SongModel): Set<string> {
  const out = new Set<string>();
  for (const l of m.lines) {
    if (!m.lead.has(l.track)) continue;
    const w = lineText(l.notes).split(" ").filter(Boolean);
    for (let i = 0; i + 3 <= w.length; i++)
      out.add(w.slice(i, i + 3).join(" "));
  }
  return out;
}

export function songFeatures(m: SongModel): SongFeatures {
  const key = m
    .keyAt(0)
    .replace(/\s*major$/i, "")
    .replace(/\s*minor$/i, "m");
  const derived: Record<string, string> = {
    "tempo band": tempoBand(m.bpm),
    key,
    "drum family": drumFamily(m),
  };
  return Object.freeze({
    id: m.id,
    classes: Object.freeze({ ...derived, ...(m.config.classes ?? {}) }),
    contour: contourOf(m),
    melody: melodyGrams(m),
    lyrics: lyricGrams(m),
    tricks: featuredTricks(m).map((t) => t.id),
  });
}

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};
const overlap = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / Math.min(a.size, b.size);
};

export type AlbumPair = Readonly<{
  a: string;
  b: string;
  shared: readonly string[];
  contourR: number;
  melodic: number;
  lyrics: number;
}>;

/**
 * Pair checks over the album. With `focus`, only the pairs that include
 * that song (a song linted against its album neighbours).
 */
export function albumRules(
  songs: readonly SongFeatures[],
  style: LintStyle,
  emit: (f: LintFinding) => void,
  focus?: string,
): AlbumPair[] {
  const s = style.sameness;
  const pairs: AlbumPair[] = [];
  const contours = songs.map((x) =>
    x.contour.length >= 8 ? resampleContour(x.contour, 64) : undefined,
  );
  for (let i = 0; i < songs.length; i++)
    for (let j = i + 1; j < songs.length; j++) {
      const a = songs[i]!;
      const b = songs[j]!;
      if (focus !== undefined && a.id !== focus && b.id !== focus) continue;
      const shared = Object.keys(a.classes).filter(
        (k) => k in b.classes && a.classes[k] === b.classes[k],
      );
      const ca = contours[i];
      const cb = contours[j];
      const r = ca && cb ? correlation(ca, cb) : NaN;
      if (r > s.contourR) shared.push(`energy contour (${r.toFixed(2)})`);
      const pair = {
        a: a.id,
        b: b.id,
        shared,
        contourR: r,
        melodic: jaccard(a.melody, b.melody),
        lyrics: overlap(a.lyrics, b.lyrics),
      };
      pairs.push(pair);
      const where = { song: `${a.id}~${b.id}` };
      if (shared.length > s.maxSharedClasses)
        emit({
          rule: "album.sameness",
          severity: "error",
          where,
          message: `${a.id} and ${b.id} share ${shared.length} classes: ${shared.join(", ")}`,
          fix: "change one song's tempo band, key, drum family, palette or space",
        });
      if (pair.melodic > s.melodicJaccard)
        emit({
          rule: "album.melody",
          severity: "warn",
          where,
          message: `${a.id} and ${b.id} share ${(pair.melodic * 100).toFixed(0)}% of melodic 4-grams (≤${s.melodicJaccard * 100}%)`,
          fix: "re-chart one song's lines with a different contour class",
        });
      if (pair.lyrics > s.lyricOverlap)
        emit({
          rule: "album.lyrics",
          severity: "warn",
          where,
          message: `${a.id} and ${b.id} share ${(pair.lyrics * 100).toFixed(0)}% of lyric 3-grams (≤${s.lyricOverlap * 100}%)`,
          fix: "rewrite the shared phrases in one song",
        });
    }
  // The ledger: a featured trick in one song of the album only.
  const owners = new Map<string, string[]>();
  for (const x of songs)
    for (const t of new Set(x.tricks))
      (owners.get(t) ?? owners.set(t, []).get(t)!).push(x.id);
  for (const [trick, ids] of owners)
    if (ids.length > 1 && (focus === undefined || ids.includes(focus)))
      emit({
        rule: "album.trick",
        severity: "error",
        where: { song: ids.join("~") },
        message: `${trick} is featured in ${ids.length} songs: ${ids.join(", ")}`,
        fix: "each featured trick belongs to one song of the album",
      });
  return pairs;
}
