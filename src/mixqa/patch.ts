// SPDX-License-Identifier: MIT
/**
 * Mix patches: the moves `mixqa --fix` solves, as data the SDK applies to a
 * score at render time (a project's `mix.patch.json`). A patch never
 * rewrites song.ts; it rides on top of it, so the song stays the author's
 * and the patch is one reviewable file.
 *
 * Moves, all in dB:
 *  - `tracks[id].gain`: the track's post gain (after every insert, before
 *    its delay and reverb sends), its lane scaled with it;
 *  - `tracks[id].eq.{low,mid,high}`: added to the track's three-band EQ
 *    (`fx.eq`); `freq` sets the band's corner/centre only when the band
 *    was unused (0 dB), so an authored band keeps its frequency;
 *  - `trims`: section trims on a list of tracks (or every track, `"*"`),
 *    as a post-gain step lane ramped over one beat at each section edge
 *    (the vocal chain's trim shape), multiplied into any lane already
 *    there;
 *  - `master.units[unit][param]`: added to a numeric parameter of a master
 *    unit the song already has; `master.target` to the loudness target.
 * Every value is clamped to the parameter's range; a move that the clamp
 * changed is reported, never silently dropped.
 */
import {
  MASTER_LIMITS,
  MASTER_SPECS,
  isMasterUnit,
  masterDefaults,
  type SongMaster,
} from "../../core/master.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FX_SPECS } from "../../core/fx.ts";
import { barStartTick } from "../../core/tempo.ts";
import {
  TrackScore,
  type AutomationPoint,
  type Track,
} from "../../core/score.ts";

export type EqBand = "low" | "mid" | "high";
export type EqMove = Readonly<{ db: number; freq?: number }>;

export type TrackMove = Readonly<{
  gain?: number;
  eq?: Readonly<Partial<Record<EqBand, EqMove>>>;
}>;

export type SectionTrim = Readonly<{
  /** Track ids, or "*" for every track. */
  tracks: readonly string[] | "*";
  /** Section name → dB. */
  sections: Readonly<Record<string, number>>;
}>;

export type MixPatch = Readonly<{
  version: 1;
  tracks?: Readonly<Record<string, TrackMove>>;
  trims?: readonly SectionTrim[];
  master?: Readonly<{
    target?: number;
    units?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  }>;
  /** Why each move was made (the solver's one-line reasons). */
  notes?: readonly string[];
}>;

export const MIX_PATCH_FILE = "mix.patch.json";

/** The project's mix patch, or undefined without one (throws if invalid). */
export async function readMixPatch(
  workspace: string,
): Promise<MixPatch | undefined> {
  let text: string;
  try {
    text = await readFile(join(workspace, MIX_PATCH_FILE), "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseMixPatch(JSON.parse(text));
  } catch (error) {
    throw new MixPatchError(
      `${MIX_PATCH_FILE}: ${(error as Error).message.slice(0, 200)}`,
    );
  }
}

export class MixPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MixPatchError";
  }
}

const EQ_FREQ: Readonly<Record<EqBand, string>> = {
  low: "lowfreq",
  mid: "midfreq",
  high: "highfreq",
};

const finite = (value: unknown, where: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new MixPatchError(`${where} must be a finite number`);
  if (Math.abs(value) > 48) throw new MixPatchError(`${where} is out of range`);
  return value;
};

/** Validate unknown JSON as a patch (throws `MixPatchError`). */
export function parseMixPatch(json: unknown): MixPatch {
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new MixPatchError("mix patch must be a JSON object");
  const record = json as Record<string, unknown>;
  if (record.version !== 1)
    throw new MixPatchError("mix patch version must be 1");
  const tracks: Record<string, TrackMove> = {};
  if (record.tracks !== undefined) {
    if (!record.tracks || typeof record.tracks !== "object")
      throw new MixPatchError("tracks must be an object");
    for (const [id, raw] of Object.entries(record.tracks)) {
      const move = (raw ?? {}) as Record<string, unknown>;
      const eq: Partial<Record<EqBand, EqMove>> = {};
      if (move.eq !== undefined) {
        for (const [band, value] of Object.entries(
          move.eq as Record<string, unknown>,
        )) {
          if (!(band in EQ_FREQ))
            throw new MixPatchError(`tracks.${id}.eq.${band} is not a band`);
          const v = (value ?? {}) as Record<string, unknown>;
          eq[band as EqBand] = {
            db: finite(v.db, `tracks.${id}.eq.${band}.db`),
            ...(v.freq === undefined
              ? {}
              : { freq: positive(v.freq, `tracks.${id}.eq.${band}.freq`) }),
          };
        }
      }
      tracks[id] = {
        ...(move.gain === undefined
          ? {}
          : { gain: finite(move.gain, `tracks.${id}.gain`) }),
        ...(Object.keys(eq).length ? { eq } : {}),
      };
    }
  }
  const trims: SectionTrim[] = [];
  if (record.trims !== undefined) {
    if (!Array.isArray(record.trims))
      throw new MixPatchError("trims must be an array");
    record.trims.forEach((raw, i) => {
      const t = (raw ?? {}) as Record<string, unknown>;
      const list = t.tracks;
      if (
        list !== "*" &&
        !(Array.isArray(list) && list.every((x) => typeof x === "string"))
      )
        throw new MixPatchError(`trims[${i}].tracks must be "*" or ids`);
      const sections: Record<string, number> = {};
      for (const [name, value] of Object.entries(
        (t.sections ?? {}) as Record<string, unknown>,
      ))
        sections[name] = finite(value, `trims[${i}].sections.${name}`);
      trims.push({ tracks: list as SectionTrim["tracks"], sections });
    });
  }
  let master: MixPatch["master"];
  if (record.master !== undefined) {
    const m = (record.master ?? {}) as Record<string, unknown>;
    const units: Record<string, Record<string, number>> = {};
    for (const [unit, params] of Object.entries(
      (m.units ?? {}) as Record<string, unknown>,
    )) {
      units[unit] = {};
      for (const [param, value] of Object.entries(
        (params ?? {}) as Record<string, unknown>,
      ))
        units[unit][param] = finite(value, `master.units.${unit}.${param}`);
    }
    master = {
      ...(m.target === undefined
        ? {}
        : { target: finite(m.target, "master.target") }),
      ...(Object.keys(units).length ? { units } : {}),
    };
  }
  const notes = Array.isArray(record.notes)
    ? record.notes.filter((n): n is string => typeof n === "string")
    : [];
  return {
    version: 1,
    ...(Object.keys(tracks).length ? { tracks } : {}),
    ...(trims.length ? { trims } : {}),
    ...(master ? { master } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

function positive(value: unknown, where: string): number {
  if (typeof value !== "number" || !(value > 0) || !Number.isFinite(value))
    throw new MixPatchError(`${where} must be a positive number`);
  return value;
}

/** True when the patch moves nothing. */
export function isEmptyPatch(patch: MixPatch): boolean {
  return (
    !Object.keys(patch.tracks ?? {}).length &&
    !(patch.trims ?? []).some((t) => Object.keys(t.sections).length) &&
    patch.master?.target === undefined &&
    !Object.keys(patch.master?.units ?? {}).length
  );
}

const round1 = (v: number) => Math.round(v * 100) / 100;

/** `b` on top of `a`: dB moves add; an EQ band keeps the first frequency. */
export function composeMixPatches(a: MixPatch, b: MixPatch): MixPatch {
  const tracks: Record<string, TrackMove> = {};
  for (const id of new Set([
    ...Object.keys(a.tracks ?? {}),
    ...Object.keys(b.tracks ?? {}),
  ])) {
    const x = a.tracks?.[id] ?? {};
    const y = b.tracks?.[id] ?? {};
    const eq: Partial<Record<EqBand, EqMove>> = {};
    for (const band of ["low", "mid", "high"] as const) {
      const p = x.eq?.[band];
      const q = y.eq?.[band];
      if (!p && !q) continue;
      const freq = p?.freq ?? q?.freq;
      eq[band] = {
        db: round1((p?.db ?? 0) + (q?.db ?? 0)),
        ...(freq === undefined ? {} : { freq }),
      };
    }
    const gain =
      x.gain === undefined && y.gain === undefined
        ? undefined
        : round1((x.gain ?? 0) + (y.gain ?? 0));
    tracks[id] = {
      ...(gain === undefined ? {} : { gain }),
      ...(Object.keys(eq).length ? { eq } : {}),
    };
  }
  const units: Record<string, Record<string, number>> = {};
  for (const source of [a.master?.units ?? {}, b.master?.units ?? {}])
    for (const [unit, params] of Object.entries(source))
      for (const [param, value] of Object.entries(params)) {
        units[unit] ??= {};
        units[unit][param] = round1((units[unit][param] ?? 0) + value);
      }
  const target =
    a.master?.target === undefined && b.master?.target === undefined
      ? undefined
      : round1((a.master?.target ?? 0) + (b.master?.target ?? 0));
  const notes = [...(a.notes ?? []), ...(b.notes ?? [])];
  const trims = [...(a.trims ?? []), ...(b.trims ?? [])];
  return {
    version: 1,
    ...(Object.keys(tracks).length ? { tracks } : {}),
    ...(trims.length ? { trims } : {}),
    ...(target !== undefined || Object.keys(units).length
      ? {
          master: {
            ...(target === undefined ? {} : { target }),
            ...(Object.keys(units).length ? { units } : {}),
          },
        }
      : {}),
    ...(notes.length ? { notes } : {}),
  };
}

export type ApplyResult = Readonly<{
  score: TrackScore;
  /** Moves the parameter ranges clamped, one line each. */
  clamped: readonly string[];
}>;

const linear = (db: number) => 10 ** (db / 20);

/** Interpolated value of a sorted lane at `tick` (held past its ends). */
function laneAt(points: readonly AutomationPoint[], tick: number): number {
  if (!points.length) return NaN;
  if (tick <= points[0]!.tick) return points[0]!.value;
  for (let i = 1; i < points.length; i += 1) {
    const b = points[i]!;
    if (tick <= b.tick) {
      const a = points[i - 1]!;
      const span = b.tick - a.tick;
      return span <= 0
        ? b.value
        : a.value + ((b.value - a.value) * (tick - a.tick)) / span;
    }
  }
  return points[points.length - 1]!.value;
}

type TrimSpan = { from: number; to: number; db: number };

/** The trim (linear) at `tick`: each span's level, ramped over its last beat into the next. */
function trimAt(spans: readonly TrimSpan[], beat: number, tick: number) {
  for (let i = 0; i < spans.length; i += 1) {
    const s = spans[i]!;
    if (tick < s.from || tick >= s.to) continue;
    const next = spans[i + 1];
    const rampFrom = s.to - beat;
    if (next && next.from === s.to && tick > rampFrom) {
      const t = (tick - rampFrom) / beat;
      return linear(s.db) + (linear(next.db) - linear(s.db)) * t;
    }
    return linear(s.db);
  }
  return 1;
}

/** Apply a patch to a score; throws `MixPatchError` on unknown tracks or units. */
export function applyMixPatch(score: TrackScore, patch: MixPatch): ApplyResult {
  const clamped: string[] = [];
  const json = score.toJSON();
  const tracks: Track[] = [...score.tracks];
  const at = (id: string) => {
    const index = tracks.findIndex((t) => t.id === id);
    if (index < 0) throw new MixPatchError(`mix patch: no track ${id}`);
    return index;
  };
  const postgainMax = Number(
    (FX_SPECS.postgain.params.gain as { max?: number }).max ?? 4,
  );
  const clampGain = (id: string, v: number) => {
    const c = Math.max(0, Math.min(postgainMax, v));
    if (Math.abs(c - v) > 1e-9)
      clamped.push(`${id} post gain ${v.toFixed(3)} → ${c.toFixed(3)}`);
    return c;
  };
  for (const [id, move] of Object.entries(patch.tracks ?? {})) {
    const index = at(id);
    let track = tracks[index]!;
    const fx = { ...(track.fx ?? {}) } as Record<
      string,
      Record<string, unknown>
    >;
    const lanes = { ...(track.fxAutomation ?? {}) } as Record<
      string,
      readonly AutomationPoint[]
    >;
    if (move.gain !== undefined && move.gain !== 0) {
      const k = linear(move.gain);
      const gain = Number(fx.postgain?.gain ?? 1);
      fx.postgain = { ...fx.postgain, gain: clampGain(id, gain * k) };
      const lane = lanes["postgain-gain"];
      if (lane)
        lanes["postgain-gain"] = lane.map((p) => ({
          tick: p.tick,
          value: clampGain(id, p.value * k),
        }));
    }
    if (move.eq) {
      const eq = { ...(fx.eq ?? {}) } as Record<string, unknown>;
      const spec = FX_SPECS.eq.params as Record<
        string,
        { min: number; max: number }
      >;
      for (const [band, m] of Object.entries(move.eq) as [EqBand, EqMove][]) {
        const range = spec[band]!;
        const before = Number(eq[band] ?? 0);
        const want = before + m.db;
        const value = Math.max(range.min, Math.min(range.max, want));
        if (Math.abs(value - want) > 1e-9)
          clamped.push(`${id} eq ${band} ${want.toFixed(2)} → ${value} dB`);
        eq[band] = round1(value);
        if (m.freq !== undefined && before === 0 && !lanes[`eq-${band}`]) {
          const fr = spec[EQ_FREQ[band]]!;
          eq[EQ_FREQ[band]] = Math.max(fr.min, Math.min(fr.max, m.freq));
        }
        const lane = lanes[`eq-${band}`];
        if (lane)
          lanes[`eq-${band}`] = lane.map((p) => ({
            tick: p.tick,
            value: Math.max(range.min, Math.min(range.max, p.value + m.db)),
          }));
      }
      fx.eq = eq;
    }
    track = {
      ...track,
      fx: fx as Track["fx"],
      ...(Object.keys(lanes).length
        ? { fxAutomation: lanes as Track["fxAutomation"] }
        : {}),
    };
    tracks[index] = track;
  }
  // Section trims: one combined step lane per track.
  const beat = score.ticksPerBeat;
  const sections = [...score.sections].sort((a, b) => a.startBar - b.startBar);
  const perTrack = new Map<string, Map<string, number>>();
  for (const trim of patch.trims ?? []) {
    const ids =
      trim.tracks === "*" ? tracks.map((t) => t.id) : [...trim.tracks];
    for (const name of Object.keys(trim.sections))
      if (!sections.some((s) => s.name === name))
        throw new MixPatchError(`mix patch: no section ${name}`);
    for (const id of ids) {
      at(id);
      const m = perTrack.get(id) ?? new Map<string, number>();
      for (const [name, db] of Object.entries(trim.sections))
        m.set(name, (m.get(name) ?? 0) + db);
      perTrack.set(id, m);
    }
  }
  for (const [id, trims] of perTrack) {
    if (![...trims.values()].some((v) => v !== 0)) continue;
    const spans: TrimSpan[] = sections.map((s) => ({
      from: barStartTick(score, s.startBar),
      to: barStartTick(score, s.startBar + s.bars),
      db: trims.get(s.name) ?? 0,
    }));
    const index = at(id);
    const track = tracks[index]!;
    const fx = { ...(track.fx ?? {}) } as Record<
      string,
      Record<string, unknown>
    >;
    const lanes = { ...(track.fxAutomation ?? {}) } as Record<
      string,
      readonly AutomationPoint[]
    >;
    const gain = Number(fx.postgain?.gain ?? 1);
    const lane = lanes["postgain-gain"] ?? [];
    const ticks = new Set<number>([0, ...lane.map((p) => p.tick)]);
    for (const s of spans) {
      ticks.add(s.from);
      ticks.add(Math.max(s.from, s.to - beat));
    }
    lanes["postgain-gain"] = [...ticks]
      .sort((a, b) => a - b)
      .map((tick) => ({
        tick,
        value: clampGain(
          id,
          (lane.length ? laneAt(lane, tick) : gain) * trimAt(spans, beat, tick),
        ),
      }));
    if (!fx.postgain) fx.postgain = { gain };
    tracks[index] = {
      ...track,
      fx: fx as Track["fx"],
      fxAutomation: lanes as Track["fxAutomation"],
    };
  }
  let master = score.master as SongMaster | undefined;
  if (patch.master) {
    if (!master) throw new MixPatchError("mix patch: the song has no master");
    const next = { ...master } as Record<string, unknown>;
    for (const [unit, params] of Object.entries(patch.master.units ?? {})) {
      // A unit the song lacks starts from its defaults (an EQ unit at 0 dB).
      const values = (next[unit] ??
        (isMasterUnit(unit) ? masterDefaults(unit) : undefined)) as
        Record<string, unknown> | undefined;
      if (!values || typeof values !== "object")
        throw new MixPatchError(`mix patch: no master unit ${unit}`);
      const spec = (
        MASTER_SPECS as Record<string, { params: Record<string, unknown> }>
      )[unit]?.params;
      const out = { ...values };
      for (const [param, delta] of Object.entries(params)) {
        const p = spec?.[param] as { min?: number; max?: number } | undefined;
        const want =
          Number(values[param] ?? (p as { default?: number })?.default ?? 0) +
          delta;
        const value = Math.max(
          p?.min ?? -Infinity,
          Math.min(p?.max ?? Infinity, want),
        );
        if (Math.abs(value - want) > 1e-9)
          clamped.push(`master ${unit}.${param} ${want.toFixed(2)} → ${value}`);
        out[param] = round1(value);
      }
      next[unit] = out;
    }
    if (patch.master.target !== undefined) {
      if (master.target === undefined)
        throw new MixPatchError("mix patch: the master has no loudness target");
      const want = master.target + patch.master.target;
      const value = Math.max(
        MASTER_LIMITS.minTarget,
        Math.min(MASTER_LIMITS.maxTarget, want),
      );
      if (value !== want) clamped.push(`master target ${want} → ${value}`);
      next.target = round1(value);
    }
    master = next as SongMaster;
  }
  const out = new TrackScore({
    ...json,
    tracks,
    ...(master ? { master } : {}),
  } as ConstructorParameters<typeof TrackScore>[0]);
  return { score: out, clamped };
}
